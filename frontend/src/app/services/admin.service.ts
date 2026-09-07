import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';
import { AuthService, UserAccess } from './auth.service';

export interface AdminUser {
  email: string;
  name: string;
  isAdmin: boolean;
  access: UserAccess;
  createdAt: string;
}

interface UsersResponse {
  success: boolean;
  users?: AdminUser[];
  error?: string;
}

interface AccessResponse {
  success: boolean;
  email?: string;
  name?: string;
  isAdmin?: boolean;
  access?: UserAccess;
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AdminService {
  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  async listUsers(): Promise<AdminUser[]> {
    const response = await firstValueFrom(
      this.http.get<UsersResponse>(`${environment.apiUrl}/api/admin/users`, { headers: this.auth.getAuthHeaders() })
    );
    if (!response.success) throw new Error(response.error || 'Failed to load users');
    return response.users || [];
  }

  async setAccess(email: string, access: UserAccess): Promise<void> {
    const response = await firstValueFrom(
      this.http.post<AccessResponse>(
        `${environment.apiUrl}/api/admin/users/${encodeURIComponent(email)}/access`,
        access,
        { headers: this.auth.getAuthHeaders() }
      )
    );
    if (!response.success) throw new Error(response.error || 'Failed to update access');
  }
}
