import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

// 'infra_ready' is New Environment-specific: Stage 1 (infra) succeeded, Stage 2
// (app setup) hasn't run yet.
export type DeploymentStatus = 'provisioning' | 'infra_ready' | 'running' | 'destroying' | 'destroyed' | 'failed';

export interface DeploymentRecord {
  id: number;
  clientName: string;
  provider: 'azure' | 'aws';
  flow?: 'dr' | 'new-env';
  env?: 'UAT' | 'PROD' | null;
  status: DeploymentStatus;
  createdBy: string;
  createdAt: string;
  readyAt: string | null;
  destroyRequestedBy: string | null;
  destroyedAt: string | null;
  durationSeconds: number | null;
  lastError: string | null;
}

interface DeploymentsResponse {
  success: boolean;
  deployments?: DeploymentRecord[];
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class DeploymentsService {
  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  async listDeployments(): Promise<DeploymentRecord[]> {
    const response = await firstValueFrom(
      this.http.get<DeploymentsResponse>(`${environment.apiUrl}/api/deployments`, { headers: this.auth.getAuthHeaders() })
    );
    if (!response.success) throw new Error(response.error || 'Failed to load deployments');
    return response.deployments || [];
  }

  // Removes a deployment's tracking row — not the same as destroy, which tears
  // down real cloud resources. The backend only allows this for failed/destroyed
  // rows, refusing anything still active.
  async deleteDeployment(id: number): Promise<void> {
    const response = await firstValueFrom(
      this.http.delete<{ success: boolean; error?: string }>(`${environment.apiUrl}/api/deployments/${id}`, { headers: this.auth.getAuthHeaders() })
    );
    if (!response.success) throw new Error(response.error || 'Failed to delete deployment');
  }
}
