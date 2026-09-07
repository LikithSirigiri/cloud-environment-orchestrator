import { Component, HostListener } from '@angular/core';
import { AuthService } from '../services/auth.service';
import { LucideAngularModule } from 'lucide-angular';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [LucideAngularModule, CommonModule],
  templateUrl: './login.component.html'
})
export class LoginComponent {
  isDarkMode = true; // Set default to true to match screenshot

  constructor(
    private authService: AuthService
  ) { }

  @HostListener('window:message', ['$event'])
  onMessage(event: MessageEvent) {
    if (event.data && event.data.type === 'LOGIN_CLICKED') {
      this.onLogin();
    }
  }

  onLogin() {
    this.authService.loginWithMicrosoft();
  }

  toggleTheme() {
    this.isDarkMode = !this.isDarkMode;
  }
}
