import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HeaderComponent } from './header.component';
import { DeploymentsService, DeploymentRecord } from '../services/deployments.service';

const POLL_INTERVAL_MS = 15000;

@Component({
  selector: 'app-activity',
  standalone: true,
  imports: [CommonModule, HeaderComponent],
  templateUrl: './activity.component.html',
  styleUrl: './activity.component.css'
})
export class ActivityComponent implements OnInit, OnDestroy {
  deployments: DeploymentRecord[] = [];
  loading = true;
  error: string | null = null;

  private pollHandle: ReturnType<typeof setInterval> | null = null;

  constructor(private deploymentsService: DeploymentsService) {}

  ngOnInit() {
    this.loadDeployments();
    this.pollHandle = setInterval(() => this.loadDeployments(), POLL_INTERVAL_MS);
  }

  ngOnDestroy() {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }

  async loadDeployments() {
    try {
      this.deployments = await this.deploymentsService.listDeployments();
      this.error = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to load activity.';
    } finally {
      this.loading = false;
    }
  }

  formatDuration(seconds: number | null): string {
    if (seconds === null) return '—';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (days) parts.push(`${days}d`);
    if (hours || days) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return parts.join(' ');
  }
}
