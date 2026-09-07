import { Component, Input, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { io } from 'socket.io-client';
import { DrConfigService, AwsNewEnvFormData } from '../services/dr-config.service';
import { DeploymentsService, DeploymentRecord } from '../services/deployments.service';
import { AwsEc2Service, FALLBACK_INSTANCE_TYPES } from '../services/aws-ec2.service';
import { PopupSelectComponent } from './popup-select/popup-select.component';

// AWS equivalent of new-environment-form.component.ts — same two-stage UI shape,
// but with its own dedicated AWS Authentication (Access Key/Secret/Region) and
// EC2 Key Pair (generate vs. existing) fields instead of Azure's Service
// Principal / admin-username-password fields. Deliberately a sibling component,
// not a shared one, so nothing here can affect the Azure form's behavior.

const LISTABLE_STATUSES = ['provisioning', 'infra_ready', 'running', 'destroying', 'failed'];

const REQUIRED_MANIFEST_KEYS = [
  'access-ui', 'flow-designer-ui', 'design-ui', 'document-hub-ui', 'support-ui',
  'screen-ui', 'field-ui', 'integration-ui', 'document-studio-ui', 'organization-ui',
  'lookup-ui', 'campaign-ui', 'dataset-ui', 'serviceability-ui', 'user-ui'
];

// Same host-bit validation as the Azure form's cidrError — AWS subnets are just
// as strict about the address being the canonical network address.
function cidrError(cidr: string): string | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!match) return `"${cidr}" isn't valid CIDR notation (expected e.g. 10.0.1.0/24).`;
  const octets = [1, 2, 3, 4].map(i => parseInt(match[i], 10));
  const prefixLength = parseInt(match[5], 10);
  if (octets.some(o => o > 255) || prefixLength > 32) {
    return `"${cidr}" isn't a valid CIDR (octet or prefix length out of range).`;
  }
  const ip = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = prefixLength === 0 ? 0 : (0xFFFFFFFF << (32 - prefixLength)) >>> 0;
  if ((ip & ~mask) >>> 0 !== 0) {
    const network = (ip & mask) >>> 0;
    const networkStr = [24, 16, 8, 0].map(shift => (network >>> shift) & 0xFF).join('.');
    return `"${cidr}" has host bits set — for a /${prefixLength}, the address should be ${networkStr}/${prefixLength}.`;
  }
  return null;
}

@Component({
  selector: 'app-aws-new-environment-form',
  standalone: true,
  imports: [CommonModule, FormsModule, PopupSelectComponent],
  templateUrl: './aws-new-environment-form.component.html',
  styleUrl: './aws-new-environment-form.component.css'
})
export class AwsNewEnvironmentFormComponent implements OnInit {
  @Input() provider: 'azure' | 'aws' | null = null;

  get formData(): Partial<AwsNewEnvFormData> { return this.drConfigService.awsNewEnvFormData; }
  set formData(value: Partial<AwsNewEnvFormData>) { this.drConfigService.awsNewEnvFormData = value; }

  get manifestVersions(): Record<string, string> | null { return this.drConfigService.awsNewEnvManifestVersions; }
  set manifestVersions(value: Record<string, string> | null) { this.drConfigService.awsNewEnvManifestVersions = value; }
  get manifestFileName(): string | null { return this.drConfigService.awsNewEnvManifestFileName; }
  set manifestFileName(value: string | null) { this.drConfigService.awsNewEnvManifestFileName = value; }

  get stage(): 'infra' | 'app' { return this.drConfigService.newEnvStageAws; }
  set stage(value: 'infra' | 'app') { this.drConfigService.newEnvStageAws = value; }

  manifestError: string | null = null;

  awsCredentials: { accessKeyId: string; secretAccessKey: string; region: string };

  showSecretAccessKey = false;
  isDeploying = false;
  deploymentLogs: string[] = [];
  generatedSecrets: Record<string, string> | null = null;
  socket: any;

  activeDeployments: DeploymentRecord[] = [];
  loadingDeployments = false;

  // Real, current EC2 instance types for the selected region, fetched from AWS —
  // starts as the small fallback list so the dropdowns are never empty while
  // credentials/region aren't filled in yet or the fetch is in flight.
  instanceTypes: string[] = FALLBACK_INSTANCE_TYPES;
  loadingInstanceTypes = false;
  instanceTypesError: string | null = null;

  // Editable key/value pairs backing formData.custom_tags — kept as an array
  // (not a live Record) purely because a Record's keys can't be edited in place
  // via ngModel without key-collision headaches while the user is still typing;
  // flattened into a Record only when building the apply payload or loading from
  // an existing deployment's config.
  tagRows: Array<{ key: string; value: string }> = [];

  // Same array-not-Record reasoning as tagRows, for Stage 2's manual microservice
  // name -> Docker image tag entries (the release manifest JSON never covered
  // these, only web portal versions).
  msRows: Array<{ name: string; tag: string }> = [];

  private destroyTargetEnv: 'UAT' | 'PROD' | null | undefined = undefined;

  // Set by editDeployment() — when non-null, the Stage 1 form is editing this
  // already-provisioned deployment's infra rather than creating a new one:
  // client_name/env/key_pair_mode become read-only, and the apply payload carries
  // `edit: true` so the backend merges into (rather than replaces) its existing
  // terraform.tfvars.json and re-applies targeted to network/security/ec2 only.
  editingDeploymentId: number | null = null;

  get providerLabel(): string {
    return this.provider === 'azure' ? 'Azure' : this.provider === 'aws' ? 'AWS' : '';
  }

  constructor(
    private drConfigService: DrConfigService,
    private deploymentsService: DeploymentsService,
    private ec2Service: AwsEc2Service,
    private cdr: ChangeDetectorRef
  ) {
    this.awsCredentials = this.drConfigService.awsCredentials;
  }

  ngOnInit() {
    this.loadActiveDeployments();

    // A visible, editable starting value (not a silent default baked into a request
    // the user never saw) — only pre-filled when the field is genuinely empty, same
    // treatment as the Azure form's Location field.
    if (!this.awsCredentials.region) {
      this.awsCredentials.region = 'ap-south-1';
    }
    if (!this.formData.web_instance_type) this.formData.web_instance_type = 't3.small';
    if (!this.formData.app_instance_type) this.formData.app_instance_type = 't3.large';
    if (!this.formData.central_instance_type) this.formData.central_instance_type = 't3.large';
    if (!this.formData.kong_instance_type) this.formData.kong_instance_type = 't3.small';
    if (!this.formData.db_instance_type) this.formData.db_instance_type = 't3.large';
    if (!this.formData.db_count) this.formData.db_count = 1;
    // Unconditional, not just "only when undefined" — these three specifically
    // always start checked on a fresh load of this component, even if the
    // dev-only localStorage persistence has an unchecked value saved from an
    // earlier test (that persistence blanket-saves everything every 1.5s
    // regardless of whether the value was a deliberate choice, so a leftover
    // false here is far more likely to be stale test state than a real user
    // decision worth preserving across a reload).
    this.formData.include_kong = true;
    this.formData.create_vpc = true;
    this.formData.create_subnets = true;

    // Only fetches if credentials/region are already filled in (e.g. restored by
    // the dev-only localStorage persistence) — otherwise the user triggers it via
    // the "Refresh" button once they've entered them.
    this.loadInstanceTypes();
  }

  loadInstanceTypes() {
    const { accessKeyId, secretAccessKey, region } = this.awsCredentials;
    if (!accessKeyId || !secretAccessKey || !region) {
      this.instanceTypesError = 'Enter your AWS Access Key, Secret Key, and Region above, then click Refresh.';
      return;
    }
    this.loadingInstanceTypes = true;
    this.instanceTypesError = null;
    this.ec2Service.getInstanceTypes(accessKeyId, secretAccessKey, region).subscribe({
      next: (types) => {
        this.instanceTypes = types.length ? types : FALLBACK_INSTANCE_TYPES;
        this.loadingInstanceTypes = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.instanceTypesError = 'Unable to fetch instance types from AWS — showing a small fallback list.';
        this.loadingInstanceTypes = false;
        this.cdr.detectChanges();
      }
    });
  }

  async loadActiveDeployments() {
    this.loadingDeployments = true;
    try {
      const all = await this.deploymentsService.listDeployments();
      this.activeDeployments = all.filter(d =>
        d.provider === 'aws' && d.flow === 'new-env' && LISTABLE_STATUSES.includes(d.status)
      );
    } catch {
      // Non-critical — the form still works without this list.
    } finally {
      this.loadingDeployments = false;
      this.cdr.detectChanges();
    }
  }

  async destroyDeployment(record: DeploymentRecord) {
    if (this.isDeploying) {
      alert('A process is already in progress. Please wait until it completes before starting a new one.');
      return;
    }
    this.editingDeploymentId = null;
    this.formData.client_name = record.clientName;
    this.destroyTargetEnv = record.env ?? null;
    await this.startDeployment('destroy', true);
  }

  setupApplication(record: DeploymentRecord) {
    if (this.isDeploying) {
      alert('A process is already in progress. Please wait until it completes before starting a new one.');
      return;
    }
    this.editingDeploymentId = null;
    this.formData.client_name = record.clientName;
    if (record.env) this.formData.env = record.env;
    this.stage = 'app';
    this.msRows = [];
    this.deploymentLogs = [];
    this.generatedSecrets = null;
  }

  // Removes a failed deployment's tracking row from the list — not the same as
  // Destroy, which runs terraform destroy against real cloud resources. Only
  // ever offered in the template for status === 'failed' rows; the backend
  // refuses this for anything still active regardless.
  async deleteDeploymentRecord(record: DeploymentRecord) {
    if (this.isDeploying) {
      alert('A process is already in progress. Please wait until it completes before starting a new one.');
      return;
    }
    const ok = await this.showConfirm(
      'Delete this deployment record?',
      `Remove "${record.clientName}" (${record.env || 'legacy'}) from this list? This only clears the tracking record — it does NOT destroy any AWS resources. Only do this if you've already confirmed nothing real was left behind (or already destroyed it).`
    );
    if (!ok) return;
    try {
      await this.deploymentsService.deleteDeployment(record.id);
      this.loadActiveDeployments();
    } catch (err: any) {
      alert(`Could not delete this deployment record: ${err.message}`);
    }
  }

  backToInfraStage() {
    this.stage = 'infra';
    this.editingDeploymentId = null;
    this.formData.client_name = '';
    this.formData.env = '';
    this.tagRows = [];
    this.msRows = [];
    this.deploymentLogs = [];
    this.generatedSecrets = null;
  }

  addTagRow() {
    this.tagRows.push({ key: '', value: '' });
  }

  removeTagRow(index: number) {
    this.tagRows.splice(index, 1);
  }

  addMsRow() {
    this.msRows.push({ name: '', tag: '' });
  }

  removeMsRow(index: number) {
    this.msRows.splice(index, 1);
  }

  // Loads an already-provisioned deployment's current Stage 1 config from the
  // backend (GET /api/deploy-new-env-aws/config) so it can be edited in place —
  // no manual state file handling. Only the fields that flow is allowed to touch
  // are populated for editing; client_name/env/key_pair_mode come back too but
  // stay read-only in the template (see the *ngIf="editingDeploymentId" guards).
  async editDeployment(record: DeploymentRecord) {
    if (this.isDeploying) {
      alert('A process is already in progress. Please wait until it completes before starting a new one.');
      return;
    }
    try {
      const params = new URLSearchParams({ clientName: record.clientName, env: record.env || '' });
      const response = await fetch(`/api/deploy-new-env-aws/config?${params}`, { headers: this.authHeader() });
      const result = await response.json();
      if (!result.success) {
        alert(`Could not load this deployment's configuration: ${result.error}`);
        return;
      }

      const config = result.config || {};
      this.formData.client_name = record.clientName;
      if (record.env) this.formData.env = record.env;
      this.formData.ssh_username = config.ssh_username;
      this.formData.ssh_allowed_ips = Array.isArray(config.ssh_allowed_ips) ? config.ssh_allowed_ips.join(',') : '';
      this.formData.https_allowed_ips = Array.isArray(config.https_allowed_ips) ? config.https_allowed_ips.join(',') : '';
      this.formData.web_instance_type = config.web_instance_type;
      this.formData.app_instance_type = config.app_instance_type;
      this.formData.central_instance_type = config.central_instance_type;
      this.formData.kong_instance_type = config.kong_instance_type;
      this.formData.db_instance_type = config.db_instance_type;
      this.formData.include_kong = config.include_kong;
      this.formData.db_count = config.db_count;
      this.formData.create_vpc = config.create_vpc;
      this.formData.existing_vpc_id = config.existing_vpc_id || '';
      this.formData.create_subnets = config.create_subnets;
      this.formData.existing_web_subnet_id = config.existing_web_subnet_id || '';
      this.formData.existing_app_subnet_id = config.existing_app_subnet_id || '';
      this.formData.existing_db_subnet_id = config.existing_db_subnet_id || '';
      this.formData.vpc_cidr = Array.isArray(config.vpc_cidr) ? config.vpc_cidr[0] : '';
      this.formData.app_subnet_prefix = Array.isArray(config.app_subnet_prefixes) ? config.app_subnet_prefixes[0] : '';
      this.formData.web_subnet_prefix = Array.isArray(config.web_subnet_prefixes) ? config.web_subnet_prefixes[0] : '';
      this.formData.db_subnet_prefix = Array.isArray(config.db_subnet_prefixes) ? config.db_subnet_prefixes[0] : '';
      const tags = config.custom_tags || {};
      this.tagRows = Object.keys(tags).map(key => ({ key, value: tags[key] }));
      this.formData.key_pair_mode = config.key_pair_mode;
      this.formData.existing_key_pair_name = config.existing_key_pair_name || '';

      this.editingDeploymentId = record.id;
      this.stage = 'infra';
      this.deploymentLogs = [];
      this.generatedSecrets = null;
      this.cdr.detectChanges();
    } catch (err: any) {
      alert(`Could not load this deployment's configuration: ${err.message}`);
    }
  }

  private authHeader(): { Authorization: string } {
    return { Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}` };
  }

  async onManifestFileSelected(event: Event) {
    this.manifestError = null;
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const versions = parsed?.versions;
      if (!versions || typeof versions !== 'object') {
        this.manifestError = 'This file has no "versions" object.';
        this.manifestVersions = null;
        this.manifestFileName = null;
        return;
      }
      const missing = REQUIRED_MANIFEST_KEYS.filter(key => !versions[key]);
      if (missing.length) {
        this.manifestError = `Missing versions for: ${missing.join(', ')}`;
        this.manifestVersions = null;
        this.manifestFileName = null;
        return;
      }
      this.manifestVersions = versions;
      this.manifestFileName = file.name;
    } catch {
      this.manifestError = 'Could not parse this file as JSON.';
      this.manifestVersions = null;
      this.manifestFileName = null;
    } finally {
      this.cdr.detectChanges();
    }
  }

  clearManifest() {
    this.manifestVersions = null;
    this.manifestFileName = null;
    this.manifestError = null;
  }

  // Custom-styled replacement for window.confirm() — same OK/Cancel semantics,
  // but returns a Promise instead of blocking synchronously, so startDeployment
  // just `await`s it in place of the old `confirm(...)` calls.
  confirmModalOpen = false;
  confirmModalTitle = '';
  confirmModalMessage = '';
  private confirmModalResolve: ((value: boolean) => void) | null = null;

  private showConfirm(title: string, message: string): Promise<boolean> {
    this.confirmModalTitle = title;
    this.confirmModalMessage = message;
    this.confirmModalOpen = true;
    return new Promise(resolve => { this.confirmModalResolve = resolve; });
  }

  respondToConfirmModal(result: boolean) {
    this.confirmModalOpen = false;
    if (this.confirmModalResolve) {
      this.confirmModalResolve(result);
      this.confirmModalResolve = null;
    }
  }

  async startDeployment(action: 'apply' | 'destroy' = 'apply', skipEnvCheck = false) {
    if (this.isDeploying) {
      alert('A process is already in progress. Please wait until it completes before starting a new one.');
      return;
    }
    if (!this.formData.client_name) {
      alert('Please enter a Client Name before starting a deployment.');
      return;
    }
    if (action === 'destroy' && !skipEnvCheck && !this.formData.env) {
      alert('Please select an Environment (UAT/PROD) before destroying — a client can have a separate deployment for each.');
      return;
    }
    const envLabel = this.formData.env ? `${this.formData.env} ` : '';
    if (action === 'destroy') {
      const ok = await this.showConfirm('Destroy environment?', `Destroy the ${envLabel}New Environment for "${this.formData.client_name}"? This cannot be undone.`);
      if (!ok) return;
    }
    if (action === 'apply' && this.editingDeploymentId) {
      const ok = await this.showConfirm('Apply infrastructure changes?', `Apply infrastructure changes to "${this.formData.client_name}" (${this.formData.env})? Depending on what changed, this may modify or replace existing EC2 resources.`);
      if (!ok) return;
    }
    if (action === 'apply' && this.stage === 'infra') {
      const missing = (['env', 'ssh_username', 'key_pair_mode', 'ssh_allowed_ips', 'https_allowed_ips',
        'web_instance_type', 'app_instance_type', 'central_instance_type', 'db_instance_type'] as const)
        .find(key => !this.formData[key]);
      if (missing) {
        alert(`Please fill in "${missing}" before provisioning infrastructure.`);
        return;
      }
      if (this.formData.key_pair_mode === 'existing' && !this.formData.existing_key_pair_name) {
        alert('Please enter the existing EC2 key pair name, or switch to "Generate a new key pair".');
        return;
      }
      if (this.formData.include_kong && !this.formData.kong_instance_type) {
        alert('Please choose a Kong instance type, or uncheck "Include Kong".');
        return;
      }
      if (![1, 3].includes(Number(this.formData.db_count))) {
        alert('DB Node Count must be 1 or 3.');
        return;
      }
      // AWS security group cidr_blocks require full CIDR notation — a bare IP like
      // "0.0.0.0" (missing "/0" or "/32") fails at `terraform apply`, not here,
      // unless caught up front. Same cidrError() used for VPC/subnet CIDRs below;
      // a lone host IP naturally passes it once written as a /32.
      const allowListFields: Array<[string, string | undefined]> = [
        ['SSH Allowed IPs', this.formData.ssh_allowed_ips],
        ['HTTPS Allowed IPs', this.formData.https_allowed_ips]
      ];
      for (const [label, value] of allowListFields) {
        for (const entry of this.splitIps(value)) {
          const err = cidrError(entry);
          if (err) {
            alert(`${label}: ${err}`);
            return;
          }
        }
      }
      if (!this.formData.create_vpc && !this.formData.existing_vpc_id) {
        alert('Please enter the existing VPC ID, or check "Create a new VPC".');
        return;
      }
      if (!this.formData.create_subnets) {
        const missingSubnet = (['existing_web_subnet_id', 'existing_app_subnet_id', 'existing_db_subnet_id'] as const)
          .find(key => !this.formData[key]);
        if (missingSubnet) {
          alert(`Please fill in "${missingSubnet}", or check "Create new subnets".`);
          return;
        }
      }
      const cidrFields: Array<[string, string | undefined]> = this.formData.create_subnets ? [
        ['VPC CIDR', this.formData.vpc_cidr],
        ['App Subnet CIDR', this.formData.app_subnet_prefix],
        ['Web Subnet CIDR', this.formData.web_subnet_prefix],
        ['DB Subnet CIDR', this.formData.db_subnet_prefix]
      ] : [];
      for (const [label, value] of cidrFields) {
        if (!value) continue; // optional — blank means "use the default"
        const err = cidrError(value);
        if (err) {
          alert(`${label}: ${err}`);
          return;
        }
      }
    }
    if (action === 'apply' && this.stage === 'app') {
      const missing = (['env', 'domain', 'kong_domain'] as const).find(key => !this.formData[key]);
      if (missing) {
        alert(`Please fill in "${missing}" before setting up the application.`);
        return;
      }
      if (!this.manifestVersions) {
        alert('Please upload a release manifest JSON (with a "versions" object) before setting up the application.');
        return;
      }
    }

    this.isDeploying = true;
    this.generatedSecrets = null;
    this.deploymentLogs = [`Initializing terraform ${action} for a new environment (${this.stage === 'infra' ? 'Stage 1: infrastructure' : 'Stage 2: application setup'})...`];

    try {
      const payload: any = {
        ...this.formData,
        action,
        stage: this.stage,
        ssh_allowed_ips: this.splitIps(this.formData.ssh_allowed_ips),
        https_allowed_ips: this.splitIps(this.formData.https_allowed_ips),
        manifest_versions: this.manifestVersions
      };

      if (action === 'destroy' && skipEnvCheck) {
        payload.env = this.destroyTargetEnv;
      }
      this.destroyTargetEnv = undefined;
      if (action === 'apply' && this.editingDeploymentId) {
        payload.edit = true;
      }
      if (action === 'apply' && this.stage === 'infra') {
        const customTags: Record<string, string> = {};
        for (const row of this.tagRows) {
          const key = row.key.trim();
          if (key) customTags[key] = row.value.trim();
        }
        payload.custom_tags = customTags;
      }
      if (action === 'apply' && this.stage === 'app') {
        const msTags: Record<string, string> = {};
        for (const row of this.msRows) {
          const name = row.name.trim();
          if (name) msTags[name] = row.tag.trim();
        }
        payload.microservice_tags = msTags;
      }

      delete payload.vpc_cidr;
      delete payload.app_subnet_prefix;
      delete payload.web_subnet_prefix;
      delete payload.db_subnet_prefix;
      if (this.formData.vpc_cidr) payload.vpc_cidr = [this.formData.vpc_cidr.trim()];
      if (this.formData.app_subnet_prefix) payload.app_subnet_prefixes = [this.formData.app_subnet_prefix.trim()];
      if (this.formData.web_subnet_prefix) payload.web_subnet_prefixes = [this.formData.web_subnet_prefix.trim()];
      if (this.formData.db_subnet_prefix) payload.db_subnet_prefixes = [this.formData.db_subnet_prefix.trim()];

      const response = await fetch(`/api/deploy-new-env-aws`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-aws-credentials': JSON.stringify(this.awsCredentials),
          ...this.authHeader()
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();

      if (!result.success) {
        this.deploymentLogs.push(`[ERROR] Backend failed to start deployment: ${result.error}`);
        this.isDeploying = false;
        this.cdr.detectChanges();
        return;
      }

      if (result.generatedSecrets) {
        this.generatedSecrets = result.generatedSecrets;
      }

      this.loadActiveDeployments();

      this.socket = io(`/${result.jobId}`);
      this.socket.on('log', (message: string) => {
        const lines = message.split('\n').filter((line: string) => line.trim() !== '');
        this.deploymentLogs.push(...lines);
        this.cdr.detectChanges();
      });

      this.pollJobLog(result.jobId, action, this.stage);
    } catch (err: any) {
      this.deploymentLogs.push(`[ERROR] Could not connect to backend API: ${err.message}`);
      this.isDeploying = false;
    }
  }

  private splitIps(value: string | undefined): string[] {
    return (value || '')
      .split(',')
      .map(ip => ip.trim())
      .filter(ip => ip.length > 0);
  }

  private pollJobLog(jobId: string, action: 'apply' | 'destroy', stage: 'infra' | 'app') {
    let shownLineCount = 0;
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}/log`, { headers: this.authHeader() });
        const result = await response.json();
        if (!result.success) return;

        const lines = (result.content as string).split('\n').filter((l: string) => l.trim() !== '');
        if (lines.length > shownLineCount) {
          this.deploymentLogs = lines;
          shownLineCount = lines.length;
          this.cdr.detectChanges();
        }

        if (result.finished) {
          clearInterval(timer);
          this.isDeploying = false;
          if (this.socket) this.socket.disconnect();
          this.loadActiveDeployments();
          // Stage 1's generated EC2 key pair (when key_pair_mode = "generate") only
          // exists once the apply that creates it finishes — surfaced here rather
          // than in the initial response, unlike the other generated secrets.
          if (result.jobSucceeded && result.additionalSecrets) {
            this.generatedSecrets = { ...(this.generatedSecrets || {}), ...result.additionalSecrets };
          }
          // A fresh Stage 1 completing is exactly when Stage 2 becomes available —
          // but an edit re-apply of an already-provisioned deployment's infra
          // should never force it into Stage 2, since app setup may already be done.
          if (action === 'apply' && stage === 'infra' && result.jobSucceeded && !this.editingDeploymentId) {
            this.stage = 'app';
          }
          this.editingDeploymentId = null;
          this.cdr.detectChanges();
        }
      } catch {
        // A transient network hiccup shouldn't stop polling — the next tick retries.
      }
    };
    const timer = setInterval(poll, 3000);
    poll();
  }
}
