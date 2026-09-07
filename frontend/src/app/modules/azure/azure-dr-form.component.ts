import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { DrConfigService, DrFormData, IpReplacement, VmConfig } from '../../services/dr-config.service';
import { VmSizeDropdownComponent } from '../../components/vm-size-dropdown/vm-size-dropdown.component';
import { AzureVmService } from '../../services/azure-vm.service';
import { environment } from '../../../environments/environment';
import { io } from 'socket.io-client';

@Component({
  selector: 'app-azure-dr-form',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule, VmSizeDropdownComponent],
  templateUrl: './azure-dr-form.component.html',
  styleUrl: './azure-dr-form.component.css'
})
export class AzureDrFormComponent implements OnInit {
  // All of these live on DrConfigService (a singleton for the app's lifetime), proxied
  // through getters/setters so every read/write goes straight to it — not a one-time
  // copy, which would silently stop tracking the service the moment any of these get
  // reassigned wholesale (pasteJson, the count-adjustment slice(), etc., all do this).
  // That's what makes the form survive navigating away and back; only an actual page
  // reload resets it, since that creates a fresh singleton.
  get formData(): Partial<DrFormData> { return this.drConfigService.formData; }
  set formData(value: Partial<DrFormData>) { this.drConfigService.formData = value; }
  get vmConfigs(): VmConfig[] { return this.drConfigService.vmConfigs; }
  set vmConfigs(value: VmConfig[]) { this.drConfigService.vmConfigs = value; }
  get ipReplacements(): IpReplacement[] { return this.drConfigService.ipReplacements; }
  set ipReplacements(value: IpReplacement[]) { this.drConfigService.ipReplacements = value; }
  get vmCount(): number { return this.drConfigService.vmCount; }
  set vmCount(value: number) { this.drConfigService.vmCount = value; }
  get ipReplacementCount(): number { return this.drConfigService.ipReplacementCount; }
  set ipReplacementCount(value: number) { this.drConfigService.ipReplacementCount = value; }

  azureCredentials: { subscriptionId: string; tenantId: string; clientId: string; clientSecret: string };

  diskSizes: string[] = [];
  mongoVersions: string[] = ['4.4', '5.0', '6.0', '7.0', '8.0'];
  confirmingDestroy: boolean = false;
  showActionDropdown: boolean = false;

  showAdminPassword = false;
  showVmAdminPassword = false;

  deploymentLogs: string[] = [];
  deploymentOutputs: any = null;
  isDeploying = false;
  socket: any;

  // Destroy Modal State
  showDestroyModal: boolean = false;
  destroyResources: any[] = [];
  isFetchingState: boolean = false;
  stateFetchError: string | null = null;
  
  isUnlocking: boolean = false;

  constructor(
    private drConfigService: DrConfigService,
    private azureVmService: AzureVmService,
    private cdr: ChangeDetectorRef
  ) {
    this.azureCredentials = this.drConfigService.azureCredentials;
  }

  private authHeader(): { Authorization: string } {
    return { Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}` };
  }

  get lockIdFromLogs(): string | null {
    const hasLockError = this.deploymentLogs.some(log => log.includes('state lock') || log.includes('lock'));
    if (!hasLockError) return null;
    
    // Look for ID: <uuid>
    const idLog = this.deploymentLogs.find(log => log.includes('ID:') && log.includes('-'));
    if (idLog) {
      const match = idLog.match(/ID:\s*([a-fA-F0-9\-]+)/);
      if (match && match[1]) return match[1];
    }
    return null;
  }

  async forceUnlock(lockId: string) {
    this.isUnlocking = true;
    this.cdr.detectChanges();
    try {
      const response = await fetch(`/api/unlock`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-azure-credentials': JSON.stringify(this.azureCredentials),
          ...this.authHeader()
        },
        body: JSON.stringify({ lockId, provider: 'azure', clientName: this.formData.client_name })
      });
      const result = await response.json();
      if (result.success) {
        this.deploymentLogs.push(`[SUCCESS] ${result.message}`);
      } else {
        this.deploymentLogs.push(`[ERROR] ${result.error}`);
      }
    } catch (err: any) {
      this.deploymentLogs.push(`[ERROR] Failed to contact API for unlock: ${err.message}`);
    } finally {
      this.isUnlocking = false;
      this.cdr.detectChanges();
    }
  }

  async initiateDestroy() {
    if (this.isDeploying) {
      alert("A process is already in progress. Please wait until it completes before starting a new one.");
      return;
    }

    if (!this.formData.client_name) {
      alert("Please enter the Client Name for the DR instance you want to destroy.");
      return;
    }

    this.showDestroyModal = true;
    this.isFetchingState = true;
    this.stateFetchError = null;
    this.destroyResources = [];
    this.cdr.detectChanges();

    try {
      const response = await fetch(`/api/state?provider=azure&clientName=${encodeURIComponent(this.formData.client_name)}`, {
        headers: {
          'x-azure-credentials': JSON.stringify(this.azureCredentials),
          ...this.authHeader()
        }
      });
      const result = await response.json();
      if (result.success) {
        this.destroyResources = result.resources;
      } else {
        this.stateFetchError = result.error || 'Failed to fetch state';
      }
    } catch (err: any) {
      this.stateFetchError = `Error connecting to API: ${err.message}`;
    } finally {
      this.isFetchingState = false;
      this.cdr.detectChanges();
    }
  }

  cancelDestroy() {
    this.showDestroyModal = false;
  }

  confirmDestroy() {
    this.showDestroyModal = false;
    this.startDeployment('destroy');
    this.toggleDropdown();
  }

  ngOnInit() {
    this.azureVmService.setCredentials(this.azureCredentials);

    // formData already reflects whatever was persisted on DrConfigService (empty on
    // this app session's first load, or whatever was previously entered otherwise) —
    // no fetch needed, it's not coming from a backend. No field gets a hardcoded
    // default value here — vm_authentication_type stays unset until the user picks one.
    this.refreshDiskSizes();

    // No fields are treated as mandatory in the UI — the stepper always shows
    // step 1 as done and step 2 as current, regardless of what's filled in.
    this.drConfigService.updateStepStatus(1, 'completed');
    this.drConfigService.updateStepStatus(2, 'current');
  }

  private refreshDiskSizes() {
    if (!this.formData.location) return;
    this.azureVmService.getDiskSizes(this.azureCredentials.subscriptionId, this.formData.location).subscribe(sizes => {
      this.diskSizes = sizes;
    });
  }

  saveCredentials() {
    this.azureVmService.setCredentials(this.azureCredentials);
    this.refreshDiskSizes();
  }

  onIpReplacementCountChange() {
    // Adjust array length to match the count, keeping existing values
    const count = Math.max(0, this.ipReplacementCount);
    if (this.ipReplacements.length < count) {
      const diff = count - this.ipReplacements.length;
      for (let i = 0; i < diff; i++) {
        this.ipReplacements.push({ serverName: '', ipAddress: '' });
      }
    } else if (this.ipReplacements.length > count) {
      this.ipReplacements = this.ipReplacements.slice(0, count);
    }
  }

  onVmCountChange() {
    const count = Math.max(0, this.vmCount);
    if (this.vmConfigs.length < count) {
      const diff = count - this.vmConfigs.length;
      for (let i = 0; i < diff; i++) {
        this.vmConfigs.push({ name: '', size: '', os_disk_size: '', needs_public_ip: false, public_ip_mode: 'new' });
      }
    } else if (this.vmConfigs.length > count) {
      this.vmConfigs = this.vmConfigs.slice(0, count);
    }
  }

  removeVm(index: number) {
    this.vmConfigs.splice(index, 1);
    this.vmCount = this.vmConfigs.length;
  }

  removeIpReplacement(index: number) {
    this.ipReplacements.splice(index, 1);
    this.ipReplacementCount = this.ipReplacements.length;
  }

  onLocationChange() {
    this.refreshDiskSizes();
  }

  toggleDropdown() {
    this.showActionDropdown = !this.showActionDropdown;
    if (!this.showActionDropdown) {
      this.confirmingDestroy = false;
    }
  }

  async startDeployment(action: string = 'apply') {
    if (this.isDeploying) {
      alert("A process is already in progress. Please wait until it completes before starting a new one.");
      return;
    }

    if (!this.formData.client_name) {
      alert("Please enter a Client Name before starting a deployment.");
      return;
    }

    this.isDeploying = true;
    this.deploymentLogs = [`Initializing terraform ${action}...`];
    
    try {
      // Format the old_ips map from the array
      if (this.ipReplacements.length > 0) {
        this.formData.old_ips = {};
        for (const item of this.ipReplacements) {
          if (item.serverName && item.ipAddress) {
            this.formData.old_ips[item.serverName] = item.ipAddress;
          }
        }
      } else {
        delete this.formData.old_ips;
      }

      // Format the vm_sizes and disk_sizes map from the array
      if (this.vmConfigs.length > 0) {
        this.formData.vm_sizes = {};
        this.formData.disk_sizes = {};
        this.formData.resource_group_names = {};
        // Only VMs explicitly checked below get a public IP — never assumed from
        // the VM's name (e.g. "web"/"kong"), so it stays optional for every VM.
        this.formData.public_ip_vms = [];
        this.formData.existing_public_ip_names = {};
        for (const vm of this.vmConfigs) {
          if (vm.name) {
            if (vm.size) this.formData.vm_sizes[vm.name] = vm.size;
            if (vm.os_disk_size) this.formData.disk_sizes[vm.name] = parseInt(vm.os_disk_size, 10);
            if (vm.resource_group_name) this.formData.resource_group_names[vm.name] = vm.resource_group_name;
            if (vm.needs_public_ip) {
              this.formData.public_ip_vms.push(vm.name);
              if (vm.public_ip_mode === 'existing' && vm.existing_public_ip_name) {
                this.formData.existing_public_ip_names[vm.name] = vm.existing_public_ip_name;
              }
            }
          }
        }
      } else {
        delete this.formData.vm_sizes;
        delete this.formData.disk_sizes;
        delete this.formData.resource_group_names;
        delete this.formData.public_ip_vms;
        delete this.formData.existing_public_ip_names;
      }

      // VNet/subnet address inputs are single CIDR strings in the UI, but
      // Terraform's variables expect a list for the VNet's address space.
      const payload: any = {
        ...this.formData,
        action: action,
        provider: 'azure'
      };
      if (this.formData.create_vnet && this.formData.vnet_address_space) {
        payload.vnet_address_space = [this.formData.vnet_address_space];
      } else {
        delete payload.vnet_address_space;
      }
      if (!this.formData.create_subnet || !this.formData.subnet_address_prefix) {
        delete payload.subnet_address_prefix;
      }

      const response = await fetch(`/api/deploy`, {
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

      // 2. Connect to the WebSocket stream for live output — but this alone isn't
      // reliable enough to depend on for correctness. A dropped connection (e.g. a
      // free ngrok tunnel silently closing a long-lived WebSocket) means the
      // browser never gets the rest of the output or the "finished" event, even
      // though the job completes normally on the backend — the deployment then
      // looks stuck forever with no error. Polling /api/jobs/:jobId/log below is
      // the actual source of truth for log content and completion; the socket is
      // just a nicer, lower-latency supplement when it happens to stay connected.
      this.socket = io(`/${result.jobId}`);
      this.socket.on('log', (message: string) => {
        const lines = message.split('\n').filter(line => line.trim() !== '');
        this.deploymentLogs.push(...lines);
        this.cdr.detectChanges();
      });

      this.pollJobLog(result.jobId);

    } catch (err: any) {
      this.deploymentLogs.push(`[ERROR] Could not connect to backend API: ${err.message}`);
      this.isDeploying = false;
    }
  }

  // Authoritative log/completion source — see the comment in startDeployment().
  // Polls the full log content on a plain interval rather than depending on the
  // WebSocket staying connected for the entire run.
  private pollJobLog(jobId: string) {
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
          this.cdr.detectChanges();
        }
      } catch {
        // A transient network hiccup shouldn't stop polling — the next tick retries.
      }
    };
    const timer = setInterval(poll, 3000);
    poll();
  }

  async pasteJson() {
    try {
      const text = await navigator.clipboard.readText();
      const parsedData = JSON.parse(text);
      this.formData = parsedData;

      // Reconstruct VM Configs
      this.vmConfigs = [];
      if (parsedData.vm_sizes) {
        const publicIpVms: string[] = parsedData.public_ip_vms || [];
        const existingPips: { [key: string]: string } = parsedData.existing_public_ip_names || {};
        const rgOverrides: { [key: string]: string } = parsedData.resource_group_names || {};
        for (const [name, size] of Object.entries(parsedData.vm_sizes)) {
          const os_disk_size = parsedData.disk_sizes && parsedData.disk_sizes[name]
            ? parsedData.disk_sizes[name].toString()
            : '';
          this.vmConfigs.push({
            name,
            size: size as string,
            os_disk_size,
            resource_group_name: rgOverrides[name] || '',
            needs_public_ip: publicIpVms.includes(name),
            public_ip_mode: existingPips[name] ? 'existing' : 'new',
            existing_public_ip_name: existingPips[name] || ''
          });
        }
      }
      this.vmCount = this.vmConfigs.length;

      // Reconstruct IP Replacements
      this.ipReplacements = [];
      if (parsedData.old_ips) {
        for (const [serverName, ipAddress] of Object.entries(parsedData.old_ips)) {
          this.ipReplacements.push({
            serverName,
            ipAddress: ipAddress as string
          });
        }
      }
      this.ipReplacementCount = this.ipReplacements.length;

      this.cdr.detectChanges();
    } catch (error) {
      console.error("Error parsing pasted JSON", error);
      alert("Invalid JSON format or clipboard access denied. Please copy valid JSON text before clicking Paste.");
    }
  }

  async downloadPem() {
    if (!this.formData.vm_ssh_key_name) {
      alert('Please provide a name for the SSH key.');
      return;
    }
    if (!this.formData.client_name) {
      alert('Please provide a Client Name.');
      return;
    }
    const filename = `${this.formData.vm_ssh_key_name}.pem`;
    try {
      const response = await fetch(
        `/api/download-pem/${filename}?provider=azure&clientName=${encodeURIComponent(this.formData.client_name)}`,
        { headers: this.authHeader() }
      );
      if (!response.ok) {
        alert('File not found. Please ensure deployment is complete.');
        return;
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`Failed to download PEM: ${err.message}`);
    }
  }

  downloadJson() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(this.formData, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "dr-config.json");
    document.body.appendChild(downloadAnchorNode); // required for firefox
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  }
}
