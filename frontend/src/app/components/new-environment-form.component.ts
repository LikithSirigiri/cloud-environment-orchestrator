import { Component, Input, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { io } from 'socket.io-client';
import { DrConfigService, NewEnvFormData } from '../services/dr-config.service';
import { DeploymentsService, DeploymentRecord } from '../services/deployments.service';

// Includes 'failed' (not just the truly "active" statuses) so a failed apply's
// leftover resources — whatever succeeded before the resource that actually failed
// — still show up here with a working Destroy button, instead of being invisible.
const LISTABLE_STATUSES = ['provisioning', 'infra_ready', 'running', 'destroying', 'failed'];

// Keys required from an uploaded release manifest's "versions" object — one per
// web portal actually routed in webconfig/nginx.conf. Must match server.js's
// KNOWN_PORTALS values exactly (the destination-folder mapping lives there).
const REQUIRED_MANIFEST_KEYS = [
  'access-ui', 'flow-designer-ui', 'design-ui', 'document-hub-ui', 'support-ui',
  'screen-ui', 'field-ui', 'integration-ui', 'document-studio-ui', 'organization-ui',
  'lookup-ui', 'campaign-ui', 'dataset-ui', 'serviceability-ui', 'user-ui'
];

// Azure's own disallowed local-admin usernames for a Linux VM (azurerm rejects these
// at apply time with a fairly deep error — catching it client-side fails in
// milliseconds instead of partway through a real Terraform apply).
const RESERVED_ADMIN_USERNAMES = [
  'administrator', 'admin', 'user', 'user1', 'test', 'user2', 'test1', 'user3', 'admin1',
  '1', '123', 'a', 'actuser', 'adm', 'admin2', 'aspnet', 'backup', 'console', 'david',
  'guest', 'john', 'owner', 'root', 'server', 'sql', 'support', 'support_388945a0',
  'sys', 'test2', 'test3', 'user4', 'user5'
];

// Azure requires 12-123 characters and at least 3 of: lowercase, uppercase, digit,
// special character.
function isValidAdminPassword(password: string): boolean {
  if (password.length < 12 || password.length > 123) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(re => re.test(password)).length;
  return classes >= 3;
}

// Validates real CIDR notation *and* that it's the canonical network address (no
// host bits set) — Azure rejects e.g. "10.0.0.1/16" with exactly this complaint
// ("for the given prefix length, the address prefix should be 10.0.0.0/16"),
// deep inside a Terraform apply. Catching it here fails in milliseconds instead.
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
  selector: 'app-new-environment-form',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './new-environment-form.component.html',
  styleUrl: './new-environment-form.component.css'
})
export class NewEnvironmentFormComponent implements OnInit {
  @Input() provider: 'azure' | 'aws' | null = null;

  // Lives on DrConfigService (a singleton for the app's lifetime) so it survives
  // navigating to Activity and back — same pattern as the DR form's formData.
  get formData(): Partial<NewEnvFormData> { return this.drConfigService.newEnvFormData; }
  set formData(value: Partial<NewEnvFormData>) { this.drConfigService.newEnvFormData = value; }

  get manifestVersions(): Record<string, string> | null { return this.drConfigService.newEnvManifestVersions; }
  set manifestVersions(value: Record<string, string> | null) { this.drConfigService.newEnvManifestVersions = value; }
  get manifestFileName(): string | null { return this.drConfigService.newEnvManifestFileName; }
  set manifestFileName(value: string | null) { this.drConfigService.newEnvManifestFileName = value; }

  get stage(): 'infra' | 'app' { return this.drConfigService.newEnvStage; }
  set stage(value: 'infra' | 'app') { this.drConfigService.newEnvStage = value; }

  manifestError: string | null = null;

  azureCredentials: { subscriptionId: string; tenantId: string; clientId: string; clientSecret: string };

  showAdminPassword = false;
  isDeploying = false;
  deploymentLogs: string[] = [];
  generatedSecrets: Record<string, string> | null = null;
  socket: any;

  showActionDropdown = false;

  activeDeployments: DeploymentRecord[] = [];
  loadingDeployments = false;

  // Set only by destroyDeployment(), right before calling startDeployment('destroy',
  // true) — see the comment there for why this can't just be formData.env.
  private destroyTargetEnv: 'UAT' | 'PROD' | null | undefined = undefined;

  get providerLabel(): string {
    return this.provider === 'azure' ? 'Azure' : this.provider === 'aws' ? 'AWS' : '';
  }

  constructor(
    private drConfigService: DrConfigService,
    private deploymentsService: DeploymentsService,
    private cdr: ChangeDetectorRef
  ) {
    this.azureCredentials = this.drConfigService.azureCredentials;
  }

  ngOnInit() {
    this.loadActiveDeployments();

    // A visible, editable starting value (not a silent default baked into a request
    // the user never saw) — only pre-filled when the field is genuinely empty, so it
    // never overwrites something the user already typed or changed.
    if (!this.formData.location) {
      this.formData.location = 'Jio India West';
    }
  }

  async loadActiveDeployments() {
    this.loadingDeployments = true;
    try {
      const all = await this.deploymentsService.listDeployments();
      this.activeDeployments = all.filter(d =>
        d.provider === 'azure' && d.flow === 'new-env' && LISTABLE_STATUSES.includes(d.status)
      );
    } catch {
      // Non-critical — the form still works without this list, just without
      // the one-click destroy convenience below.
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
    this.formData.client_name = record.clientName;
    // A dedicated field, not formData.env — that's typed 'UAT'|'PROD'|'' and can't
    // represent "explicitly the legacy no-env row" distinctly from "not chosen
    // yet". The backend treats env:null and env:undefined differently (null means
    // exactly the legacy row; undefined means "don't care, could grab the wrong
    // one"), so this distinction has to survive all the way to the request body.
    this.destroyTargetEnv = record.env ?? null;
    // The row already tells us definitively which deployment this is, env or not
    // — skip the "must pick an env" prompt that the standalone Destroy button needs.
    await this.startDeployment('destroy', true);
  }

  // Picks up Stage 2 for a client whose infra is already 'infra_ready' — from the
  // Active Deployments list, possibly in a later session than the one that ran
  // Stage 1 (that's why this is driven by the list, not just an in-memory flag set
  // right after Stage 1 finishes). env comes from the row, not re-entered — a
  // client can have both a UAT and PROD row, and this must target the right one.
  setupApplication(record: DeploymentRecord) {
    if (this.isDeploying) {
      alert('A process is already in progress. Please wait until it completes before starting a new one.');
      return;
    }
    this.formData.client_name = record.clientName;
    if (record.env) this.formData.env = record.env;
    this.stage = 'app';
    this.deploymentLogs = [];
    this.generatedSecrets = null;
  }

  // Lets the user start a fresh Stage 1 for a different client without needing to
  // reload the page, if they'd switched into Stage 2 mode for another client.
  backToInfraStage() {
    this.stage = 'infra';
    this.formData.client_name = '';
    this.formData.env = '';
    this.deploymentLogs = [];
    this.generatedSecrets = null;
  }

  private authHeader(): { Authorization: string } {
    return { Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}` };
  }

  toggleDropdown() {
    this.showActionDropdown = !this.showActionDropdown;
  }

  // Reads the uploaded release manifest (e.g. 5.1.2026.08.15.000.json) client-side
  // and pulls out its "versions" object — the exact per-portal version strings used
  // to fetch the exact build zip for each portal, instead of guessing "latest".
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

  // skipEnvCheck: true when called from a specific Active Deployments row (which
  // already unambiguously identifies the deployment, env or not) — the standalone
  // Destroy button below the form still requires picking an env, since it has no
  // other way to know which of a client's deployments (UAT/PROD/legacy) is meant.
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
    if (action === 'destroy' && !confirm(`Destroy the ${envLabel}New Environment for "${this.formData.client_name}"? This cannot be undone.`)) {
      return;
    }
    if (action === 'apply' && this.stage === 'infra') {
      const missing = (['env', 'location', 'admin_username', 'admin_password', 'ssh_allowed_ips', 'https_allowed_ips'] as const)
        .find(key => !this.formData[key]);
      if (missing) {
        alert(`Please fill in "${missing}" before provisioning infrastructure.`);
        return;
      }
      const username = (this.formData.admin_username || '').trim().toLowerCase();
      if (RESERVED_ADMIN_USERNAMES.includes(username)) {
        alert(`"${this.formData.admin_username}" is a reserved VM admin username on Azure and will be rejected. Pick something else (e.g. not admin/root/administrator/guest/etc).`);
        return;
      }
      if (!isValidAdminPassword(this.formData.admin_password || '')) {
        alert('VM Admin Password must be 12-123 characters and include at least 3 of: lowercase, uppercase, digit, special character.');
        return;
      }
      const cidrFields: Array<[string, string | undefined]> = [
        ['VNet CIDR', this.formData.vnet_address_space],
        ['App Subnet CIDR', this.formData.app_subnet_prefix],
        ['Web Subnet CIDR', this.formData.web_subnet_prefix],
        ['DB Subnet CIDR', this.formData.db_subnet_prefix]
      ];
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
    this.showActionDropdown = false;

    try {
      const payload: any = {
        ...this.formData,
        action,
        stage: this.stage,
        ssh_allowed_ips: this.splitIps(this.formData.ssh_allowed_ips),
        https_allowed_ips: this.splitIps(this.formData.https_allowed_ips),
        manifest_versions: this.manifestVersions
      };

      // A record-triggered destroy carries the row's exact env (which can be
      // `null` for a legacy pre-env-scoping deployment) instead of whatever's in
      // formData.env — see destroyTargetEnv's declaration for why.
      if (action === 'destroy' && skipEnvCheck) {
        payload.env = this.destroyTargetEnv;
      }
      this.destroyTargetEnv = undefined;

      // Optional CIDR overrides — the form collects one CIDR per field, but the
      // backend/Terraform expect a list; wrap each into a one-element array, and
      // omit entirely when left blank so Terraform's own defaults apply instead.
      delete payload.vnet_address_space;
      delete payload.app_subnet_prefix;
      delete payload.web_subnet_prefix;
      delete payload.db_subnet_prefix;
      if (this.formData.vnet_address_space) payload.vnet_address_space = [this.formData.vnet_address_space.trim()];
      if (this.formData.app_subnet_prefix) payload.app_subnet_prefixes = [this.formData.app_subnet_prefix.trim()];
      if (this.formData.web_subnet_prefix) payload.web_subnet_prefixes = [this.formData.web_subnet_prefix.trim()];
      if (this.formData.db_subnet_prefix) payload.db_subnet_prefixes = [this.formData.db_subnet_prefix.trim()];

      const response = await fetch(`/api/deploy-new-env`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-azure-credentials': JSON.stringify(this.azureCredentials),
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

      // Same dual log source as the DR form: the socket gives low-latency live
      // output, but /api/jobs/:jobId/log polling below is the actual source of
      // truth for completion, since a dropped WebSocket would otherwise leave
      // the UI stuck with no error even though the backend job finished fine.
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
          // Stage 1 succeeding is exactly when Stage 2 becomes available — move the
          // form there automatically for this session. (Picking it up in a later
          // session instead goes through the Active Deployments list's "Setup
          // Application" button, since this in-memory flip wouldn't survive that.)
          if (action === 'apply' && stage === 'infra' && result.jobSucceeded) {
            this.stage = 'app';
          }
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
