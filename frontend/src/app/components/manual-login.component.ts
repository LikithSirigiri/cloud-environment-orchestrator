import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../services/auth.service';

// Break-glass admin login -- intentionally not linked from anywhere in the
// UI (no nav link, not referenced by login.component). Reachable only by
// someone who already knows this route exists. The backend rejects every
// attempt unless FALLBACK_ADMIN_USERNAME/PASSWORD_HASH/JWT_SECRET are set in
// .env, so this route is a no-op unless deliberately configured.
@Component({
  selector: 'app-manual-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="w-screen h-screen flex items-center justify-center bg-[#07051a] text-white">
      <form (ngSubmit)="onSubmit()" class="w-full max-w-sm px-8 py-10 rounded-xl border border-white/10 bg-white/5">
        <h1 class="text-lg font-semibold mb-6 text-white/90">Manual access</h1>

        <label class="block text-sm text-white/60 mb-1">Username</label>
        <input
          type="text"
          name="username"
          [(ngModel)]="username"
          autocomplete="username"
          class="w-full mb-4 px-3 py-2 rounded bg-white/10 border border-white/10 text-white outline-none focus:border-white/30"
        />

        <label class="block text-sm text-white/60 mb-1">Password</label>
        <input
          type="password"
          name="password"
          [(ngModel)]="password"
          autocomplete="current-password"
          class="w-full mb-6 px-3 py-2 rounded bg-white/10 border border-white/10 text-white outline-none focus:border-white/30"
        />

        <button
          type="submit"
          [disabled]="submitting"
          class="w-full py-2 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
        >
          {{ submitting ? 'Signing in…' : 'Sign in' }}
        </button>

        <p *ngIf="errorMessage" class="mt-4 text-sm text-red-400">{{ errorMessage }}</p>
      </form>
    </div>
  `
})
export class ManualLoginComponent {
  username = '';
  password = '';
  submitting = false;
  errorMessage: string | null = null;

  constructor(private authService: AuthService) {}

  async onSubmit() {
    if (this.submitting) return;
    this.submitting = true;
    this.errorMessage = null;

    try {
      await this.authService.loginManual(this.username, this.password);
    } catch (err) {
      this.errorMessage = this.extractErrorMessage(err);
    } finally {
      this.submitting = false;
    }
  }

  private extractErrorMessage(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      return err.error?.error || 'Sign-in failed.';
    }
    return err instanceof Error ? err.message : 'Sign-in failed.';
  }
}
