import { Component, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { environment } from '../../../environments/environment';
import { io } from 'socket.io-client';
import { LucideAngularModule } from 'lucide-angular';

@Component({
  selector: 'app-aws-dr-form',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './aws-dr-form.component.html',
  styleUrl: './aws-dr-form.component.css'
})
export class AwsDrFormComponent {
  formData: any = {
    client_name: '',
    dc_region: 'us-east-1',
    dr_region: 'us-west-2',
    dr_vpc_name: 'dr-vpc',
    dr_vpc_cidr: '10.1.0.0/16',
    dr_public_subnet_cidr: '10.1.1.0/24',
    dr_private_subnet_cidr: '10.1.2.0/24',
    dr_availability_zone: 'us-west-2a',
    dr_az_count: 1,
    mongodb_version: '6.0',
    db_server_count: 1,
    ssh_username: 'ubuntu',
    local_pem_filename: 'dr-key.pem'
  };

  serverCount: number = 0;
  serverConfigs: { role: string; dc_tag: string; dc_ip: string; dr_instance_type: string }[] = [];

  isDeploying = false;
  deploymentLogs: string[] = [];
  socket: any;

  constructor(private cdr: ChangeDetectorRef) {}

  private authHeader(): { Authorization: string } {
    return { Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}` };
  }

  onServerCountChange() {
    const count = Math.max(0, this.serverCount);
    if (this.serverConfigs.length < count) {
      const diff = count - this.serverConfigs.length;
      for (let i = 0; i < diff; i++) {
        this.serverConfigs.push({ role: '', dc_tag: '', dc_ip: '', dr_instance_type: 't3.micro' });
      }
    } else if (this.serverConfigs.length > count) {
      this.serverConfigs = this.serverConfigs.slice(0, count);
    }
  }

  removeServer(index: number) {
    this.serverConfigs.splice(index, 1);
    this.serverCount = this.serverConfigs.length;
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
    this.deploymentLogs = [`Initializing AWS terraform ${action}...`];

    try {
      // Format the maps from the array
      if (this.serverConfigs.length > 0) {
        this.formData.dc_server_tags = {};
        this.formData.dc_server_ips = {};
        this.formData.dr_instance_types = {};
        for (const srv of this.serverConfigs) {
          if (srv.role) {
            this.formData.dc_server_tags[srv.role] = srv.dc_tag || '';
            this.formData.dc_server_ips[srv.role] = srv.dc_ip || '';
            this.formData.dr_instance_types[srv.role] = srv.dr_instance_type || 't3.micro';
          }
        }
      } else {
        delete this.formData.dc_server_tags;
        delete this.formData.dc_server_ips;
        delete this.formData.dr_instance_types;
      }

      const payload = {
        ...this.formData,
        action: action,
        provider: 'aws'
      };
      
      const response = await fetch(`/api/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeader() },
        body: JSON.stringify(payload)
      });
      
      const result = await response.json();
      
      if (!result.success) {
        this.deploymentLogs.push(`[ERROR] Backend failed to start deployment: ${result.error}`);
        this.isDeploying = false;
        return;
      }

      this.socket = io(`/${result.jobId}`);
      
      this.socket.on('log', (message: string) => {
        const lines = message.split('\\n').filter(line => line.trim() !== '');
        this.deploymentLogs.push(...lines);
        this.cdr.detectChanges();
      });
      
      this.socket.on('finished', (data: any) => {
        this.isDeploying = false;
        this.socket.disconnect();
        this.cdr.detectChanges();
      });
      
    } catch (err: any) {
      this.deploymentLogs.push(`[ERROR] Could not connect to backend API: ${err.message}`);
      this.isDeploying = false;
    }
  }
}
