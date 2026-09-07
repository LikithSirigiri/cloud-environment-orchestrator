import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HeaderComponent } from './header.component';
import { AdminService, AdminUser } from '../services/admin.service';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [CommonModule, HeaderComponent],
  templateUrl: './admin.component.html',
  styleUrl: './admin.component.css'
})
export class AdminComponent implements OnInit {
  users: AdminUser[] = [];
  loading = true;
  error: string | null = null;
  savingEmail: string | null = null;

  constructor(private adminService: AdminService) {}

  ngOnInit() {
    this.loadUsers();
  }

  async loadUsers() {
    this.loading = true;
    this.error = null;
    try {
      this.users = await this.adminService.listUsers();
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to load users.';
    } finally {
      this.loading = false;
    }
  }

  async toggleAccess(user: AdminUser, provider: 'azure' | 'aws') {
    const previous = { ...user.access };
    user.access = { ...user.access, [provider]: !user.access[provider] };
    this.savingEmail = user.email;

    try {
      await this.adminService.setAccess(user.email, user.access);
    } catch (err) {
      user.access = previous;
      this.error = err instanceof Error ? err.message : 'Failed to update access.';
    } finally {
      this.savingEmail = null;
    }
  }
}
