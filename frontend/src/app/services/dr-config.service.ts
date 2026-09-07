import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject } from 'rxjs';

export interface IpReplacement {
  serverName: string;
  ipAddress: string;
}

export interface VmConfig {
  name: string;
  size: string;
  os_disk_size: string;
  resource_group_name?: string;
  needs_public_ip?: boolean;
  public_ip_mode?: 'new' | 'existing';
  existing_public_ip_name?: string;
}

export interface DrFormData {
  client_name: string;
  resource_group_name: string;
  resource_group_names?: { [key: string]: string };
  location: string;
  create_vnet?: boolean;
  vnet_name: string;
  vnet_address_space?: string;
  create_subnet?: boolean;
  subnet_name: string;
  subnet_address_prefix?: string;
  create_nat_gateway?: boolean;
  nat_gateway_name: string;
  admin_username: string;
  admin_password?: string;
  vm_admin_username: string;
  vm_admin_password?: string;
  vm_authentication_type?: 'password' | 'ssh_key';
  vm_ssh_key_name?: string;
  vm_size?: string;
  vm_sizes?: { [key: string]: string };
  disk_type: string;
  disk_sizes?: { [key: string]: number };
  public_ip_vms?: string[];
  existing_public_ip_names?: { [key: string]: string };
  storage_account_name?: string;
  old_ips?: { [key: string]: string };
  mongo_server_count?: number;
  mongo_resource_group_name?: string;
  mongo_version?: string;
  mongo_vm_size?: string;
  mongo_os_disk_size?: number | string;
  stream_full_logs?: boolean;
}

export interface NewEnvFormData {
  client_name: string;
  // Not an infra dimension (no separate RGs/state/VMs per env, unlike DR-era Jenkins) —
  // purely used to build the "<client>-<env>" build-artifacts container name in the
  // shared storage account, matching how those containers are already named there.
  env: 'UAT' | 'PROD' | '';
  location: string;
  domain: string;
  kong_domain: string;
  admin_username: string;
  admin_password?: string;
  ssh_allowed_ips: string;   // comma-separated in the form, split before sending
  https_allowed_ips: string; // comma-separated in the form, split before sending
  // Optional CIDR overrides — Terraform has its own defaults (10.0.0.0/16,
  // 10.0.1.0/24, 10.0.2.0/24, 10.0.3.0/24) if these are left blank.
  vnet_address_space?: string;
  app_subnet_prefix?: string;
  web_subnet_prefix?: string;
  db_subnet_prefix?: string;
  stream_full_logs?: boolean;
}

export interface AwsNewEnvFormData {
  client_name: string;
  // Same non-infra-dimension role as Azure's NewEnvFormData.env — see that comment.
  env: 'UAT' | 'PROD' | '';
  domain: string;
  kong_domain: string;
  ssh_username: string;
  // "generate": Terraform creates and returns a new key pair (private key shown
  // once, like the other generated secrets). "existing": references a key pair
  // already registered in the target AWS account/region by name.
  key_pair_mode: 'generate' | 'existing' | '';
  existing_key_pair_name?: string;
  ssh_allowed_ips: string;   // comma-separated in the form, split before sending
  https_allowed_ips: string; // comma-separated in the form, split before sending
  // Optional CIDR overrides — Terraform has its own defaults (10.0.0.0/16,
  // 10.0.1.0/24, 10.0.2.0/24, 10.0.3.0/24) if these are left blank. Only used
  // when create_subnets is true — meaningless once subnets already exist.
  vpc_cidr?: string;
  app_subnet_prefix?: string;
  web_subnet_prefix?: string;
  db_subnet_prefix?: string;
  // Create-vs-existing VPC/subnets — create_subnets covers all three (web/app/db)
  // together, not independently.
  create_vpc: boolean;
  existing_vpc_id?: string;
  create_subnets: boolean;
  existing_web_subnet_id?: string;
  existing_app_subnet_id?: string;
  existing_db_subnet_id?: string;
  // Applied to every taggable resource this deployment creates (VPC/subnets/
  // security groups/EC2 instances/etc.) — AWS-only capability, no Azure equivalent.
  custom_tags?: Record<string, string>;
  // Stage 2 only — microservice name -> Docker image tag, entered manually (the
  // release manifest JSON only ever covered web portal versions, never these).
  // Captured and written to the app instance for now; not yet wired into an
  // actual docker-compose pull/run step, same as no microservice is today.
  microservice_tags?: Record<string, string>;
  // Per-role EC2 instance sizing — AWS-only capability, no Azure equivalent.
  web_instance_type: string;
  app_instance_type: string;
  central_instance_type: string;
  kong_instance_type: string;
  db_instance_type: string;
  // Whether to provision a Kong instance at all.
  include_kong: boolean;
  // 1 = a plain standalone MongoDB (today's behavior). >1 = a real PSS MongoDB
  // replica set across that many nodes.
  db_count: number;
  stream_full_logs?: boolean;
}

export interface ServerOverride {
  name: string;
  disk_size: string;
  old_ip?: string;
  status: string;
  mount_path?: string;
  vm_size?: string;
}

export interface DrStep {
  id: number;
  label: string;
  status: 'completed' | 'current' | 'upcoming';
}

@Injectable({
  providedIn: 'root'
})
export class DrConfigService {
  // TODO: Replace with your actual Terraform API endpoint
  private apiUrl = '/api/terraform-config';

  private stepState = new BehaviorSubject<DrStep[]>([
    { id: 1, label: 'Configuration', status: 'current' },
    { id: 2, label: 'Validation', status: 'upcoming' },
    { id: 3, label: 'Setup', status: 'upcoming' }
  ]);

  steps$ = this.stepState.asObservable();

  updateStepStatus(stepId: number, status: 'completed' | 'current' | 'upcoming') {
    const currentSteps = this.stepState.value;
    const newSteps = currentSteps.map(s => s.id === stepId ? { ...s, status } : s);
    this.stepState.next(newSteps);
  }

  // Holds the Azure DR form's in-progress state for as long as the app stays open.
  // This service is a singleton for the app's lifetime, so it survives navigating
  // between routes (e.g. to Activity and back) — the form component just reads/writes
  // these directly instead of owning its own copy that resets every time it's
  // destroyed and recreated. A real page reload (F5) still resets it, since that
  // creates a whole new app instance and a fresh singleton — matching "only refreshing
  // manually should reset it."
  formData: Partial<DrFormData> = {};
  azureCredentials = {
    subscriptionId: '',
    tenantId: '',
    clientId: '',
    clientSecret: ''
  };
  vmCount = 0;
  vmConfigs: VmConfig[] = [];
  ipReplacementCount = 0;
  ipReplacements: IpReplacement[] = [];

  // Same survives-navigation reasoning as formData, for the New Environment form.
  newEnvFormData: Partial<NewEnvFormData> = {};

  // Parsed "versions" object from an uploaded release manifest (e.g.
  // 5.1.2026.08.15.000.json) — maps "<portal>-ui" keys to exact version strings,
  // used to fetch the exact build zip for each portal instead of guessing "latest".
  newEnvManifestVersions: Record<string, string> | null = null;
  newEnvManifestFileName: string | null = null;

  // Which of New Environment's two apply stages the form is currently showing —
  // 'infra' (default) asks for VM/networking details, 'app' asks for the release
  // manifest/domain/kong once Stage 1 has landed at 'infra_ready'.
  newEnvStage: 'infra' | 'app' = 'infra';

  // AWS New Environment — a fully separate form/credentials/stage from Azure's
  // above, so switching between the two providers' forms never cross-contaminates
  // either one's in-progress state.
  awsNewEnvFormData: Partial<AwsNewEnvFormData> = {};
  awsCredentials = {
    accessKeyId: '',
    secretAccessKey: '',
    region: ''
  };
  awsNewEnvManifestVersions: Record<string, string> | null = null;
  awsNewEnvManifestFileName: string | null = null;
  newEnvStageAws: 'infra' | 'app' = 'infra';

  // Same reasoning as above — which provider (AWS/Azure) is selected on the Dashboard
  // must survive navigating to Activity and back, not just the form fields within it.
  selectedProvider: 'azure' | 'aws' | null = null;

  // Which workflow (DR vs provisioning a brand-new environment) is selected for the
  // chosen provider — same survives-navigation reasoning as selectedProvider.
  selectedMode: 'dr' | 'new' | null = null;

  constructor(private http: HttpClient) { }

  getServerOverrides(): Observable<ServerOverride[]> {
    return this.http.get<ServerOverride[]>(`${this.apiUrl}/servers`);
  }

  getSteps(): Observable<DrStep[]> {
    return this.http.get<DrStep[]>(`${this.apiUrl}/steps`);
  }
}
