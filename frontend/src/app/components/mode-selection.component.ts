import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-mode-selection',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './mode-selection.component.html',
  styleUrl: './mode-selection.component.css'
})
export class ModeSelectionComponent {
  @Input() provider: 'azure' | 'aws' | null = null;
  @Output() modeSelected = new EventEmitter<'dr' | 'new'>();

  get providerLabel(): string {
    return this.provider === 'azure' ? 'Azure' : this.provider === 'aws' ? 'AWS' : '';
  }

  selectMode(mode: 'dr' | 'new') {
    this.modeSelected.emit(mode);
  }
}
