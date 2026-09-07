import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService, UserAccess } from '../services/auth.service';

@Component({
  selector: 'app-provider-selection',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './provider-selection.component.html',
  styleUrl: './provider-selection.component.css'
})
export class ProviderSelectionComponent implements OnInit {
  @Output() providerSelected = new EventEmitter<'azure' | 'aws'>();

  access: UserAccess = { azure: false, aws: false };
  tiltX = 0;
  tiltY = 0;

  constructor(private authService: AuthService) {}

  ngOnInit() {
    this.access = this.authService.currentProfile?.access || { azure: false, aws: false };
    this.authService.profile$.subscribe(profile => {
      this.access = profile?.access || { azure: false, aws: false };
    });
    this.authService.refreshProfile().catch(() => {});
  }

  selectProvider(provider: 'azure' | 'aws') {
    this.providerSelected.emit(provider);
  }

  onPendingMouseMove(event: MouseEvent) {
    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    this.tiltY = px * 18;
    this.tiltX = -py * 18;
  }

  onPendingMouseLeave() {
    this.tiltX = 0;
    this.tiltY = 0;
  }
}
