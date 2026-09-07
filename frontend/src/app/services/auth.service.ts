import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';

const OAUTH_STATE_KEY = 'oauth_state';
const PROFILE_KEY = 'user_profile';

// crypto.randomUUID() only exists in a secure context (HTTPS or localhost) --
// it's undefined over plain http:// on a real host, which crashes login
// before it can redirect. This value is just CSRF-protection state, not a
// security-sensitive identifier, so a Math.random fallback is fine here.
function randomState(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface UserAccess {
  azure: boolean;
  aws: boolean;
}

export interface UserProfile {
  email: string;
  name: string;
  isAdmin: boolean;
  access: UserAccess;
}

interface TokenResponse {
  success: boolean;
  idToken?: string;
  name?: string;
  username?: string;
  isAdmin?: boolean;
  access?: UserAccess;
  error?: string;
}

interface MeResponse {
  success: boolean;
  email?: string;
  name?: string;
  isAdmin?: boolean;
  access?: UserAccess;
  error?: string;
}

interface AzureAdConfig {
  clientId: string;
  tenantId: string;
  redirectUri: string;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private loggedIn = new BehaviorSubject<boolean>(this.hasToken());
  isLoggedIn$ = this.loggedIn.asObservable();

  private profile = new BehaviorSubject<UserProfile | null>(this.readStoredProfile());
  profile$ = this.profile.asObservable();

  constructor(
    private router: Router,
    private http: HttpClient
  ) {}

  private hasToken(): boolean {
    return !!localStorage.getItem('auth_token');
  }

  private readStoredProfile(): UserProfile | null {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as UserProfile;
    } catch {
      return null;
    }
  }

  private storeProfile(profile: UserProfile) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    localStorage.setItem('user_name', profile.name || profile.email || '');
    this.profile.next(profile);
  }

  getAuthHeaders(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}` });
  }

  get currentProfile(): UserProfile | null {
    return this.profile.value;
  }

  /** Redirects the browser to Microsoft's login page (Authorization Code flow). */
  async loginWithMicrosoft() {
    const config = await firstValueFrom(
      this.http.get<AzureAdConfig>(`${environment.apiUrl}/api/auth/config`)
    );

    const state = randomState();
    sessionStorage.setItem(OAUTH_STATE_KEY, state);

    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: config.redirectUri,
      response_mode: 'query',
      scope: 'openid profile email User.Read',
      state
    });

    window.location.href = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  /** Exchanges the authorization code (received on /auth/callback) for tokens via the backend. */
  async completeMicrosoftLogin(code: string, state: string | null): Promise<void> {
    const expectedState = sessionStorage.getItem(OAUTH_STATE_KEY);
    sessionStorage.removeItem(OAUTH_STATE_KEY);

    if (!expectedState || state !== expectedState) {
      throw new Error('Invalid OAuth state');
    }

    const response = await firstValueFrom(
      this.http.post<TokenResponse>(`${environment.apiUrl}/api/auth/token`, { code })
    );

    if (!response.success || !response.idToken) {
      throw new Error(response.error || 'Authentication failed');
    }

    localStorage.setItem('auth_token', response.idToken);
    this.storeProfile({
      email: response.username || '',
      name: response.name || response.username || '',
      isAdmin: !!response.isAdmin,
      access: response.access || { azure: false, aws: false }
    });
    this.loggedIn.next(true);
    this.router.navigate(['/dashboard']);
  }

  /** Break-glass login, bypassing Azure AD entirely -- backend rejects unless FALLBACK_ADMIN_* is set in .env. */
  async loginManual(username: string, password: string): Promise<void> {
    const response = await firstValueFrom(
      this.http.post<TokenResponse>(`${environment.apiUrl}/api/auth/fallback-login`, { username, password })
    );

    if (!response.success || !response.idToken) {
      throw new Error(response.error || 'Authentication failed');
    }

    localStorage.setItem('auth_token', response.idToken);
    this.storeProfile({
      email: response.username || '',
      name: response.name || response.username || '',
      isAdmin: !!response.isAdmin,
      access: response.access || { azure: false, aws: false }
    });
    this.loggedIn.next(true);
    this.router.navigate(['/dashboard']);
  }

  /** Re-fetches the current user's access/role from the backend (e.g. after an admin grants access). */
  async refreshProfile(): Promise<void> {
    const response = await firstValueFrom(
      this.http.get<MeResponse>(`${environment.apiUrl}/api/me`, { headers: this.getAuthHeaders() })
    );

    if (!response.success) return;

    this.storeProfile({
      email: response.email || '',
      name: response.name || response.email || '',
      isAdmin: !!response.isAdmin,
      access: response.access || { azure: false, aws: false }
    });
  }

  logout() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('user_name');
    localStorage.removeItem(PROFILE_KEY);
    this.profile.next(null);
    this.loggedIn.next(false);
    this.router.navigate(['/login']);
  }

  getUserName(): string | null {
    return localStorage.getItem('user_name');
  }
}
