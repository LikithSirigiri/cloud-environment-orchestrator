import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-auth-callback',
  standalone: true,
  template: `
    <div class="w-screen h-screen flex items-center justify-center bg-[#07051a] text-white">
      <p>{{ errorMessage || 'Signing you in…' }}</p>
    </div>
  `
})
export class AuthCallbackComponent implements OnInit {
  errorMessage: string | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private authService: AuthService
  ) {}

  async ngOnInit() {
    const params = this.route.snapshot.queryParamMap;
    const code = params.get('code');
    const state = params.get('state');
    const error = params.get('error_description') || params.get('error');

    if (error) {
      this.errorMessage = error;
      return;
    }

    if (!code) {
      this.errorMessage = 'Missing authorization code from Microsoft.';
      return;
    }

    try {
      await this.authService.completeMicrosoftLogin(code, state);
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : 'Sign-in failed.';
      setTimeout(() => this.router.navigate(['/login']), 2000);
    }
  }
}
