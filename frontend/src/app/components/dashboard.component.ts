import { Component, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HeaderComponent } from './header.component';
import { StepperComponent } from './stepper.component';
import { AzureDrFormComponent } from '../modules/azure/azure-dr-form.component';
import { AwsDrFormComponent } from '../modules/aws/aws-dr-form.component';
import { ProviderSelectionComponent } from './provider-selection.component';
import { ModeSelectionComponent } from './mode-selection.component';
import { NewEnvironmentFormComponent } from './new-environment-form.component';
import { AwsNewEnvironmentFormComponent } from './aws-new-environment-form.component';
import { TransitionService } from '../services/transition.service';
import { DrConfigService } from '../services/dr-config.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, HeaderComponent, StepperComponent, AzureDrFormComponent, AwsDrFormComponent, ProviderSelectionComponent, ModeSelectionComponent, NewEnvironmentFormComponent, AwsNewEnvironmentFormComponent],
  templateUrl: './dashboard.component.html'
})
export class DashboardComponent {
  // Both live on DrConfigService (a singleton for the app's lifetime) instead of as
  // local fields, so they survive navigating to Activity and back — only an actual
  // page reload resets them.
  get selectedProvider(): 'azure' | 'aws' | null {
    return this.drConfigService.selectedProvider;
  }

  get selectedMode(): 'dr' | 'new' | null {
    return this.drConfigService.selectedMode;
  }

  constructor(
    private drConfigService: DrConfigService,
    private transitionService: TransitionService,
    private cdr: ChangeDetectorRef
  ) {}

  onProviderSelected(provider: 'azure' | 'aws' | null) {
    this.transitionService.playFullTransition(() => {
      this.drConfigService.selectedProvider = provider;
      this.drConfigService.selectedMode = null;
      setTimeout(() => this.cdr.detectChanges(), 0); // Force DOM update in next tick
    });
  }

  onModeSelected(mode: 'dr' | 'new' | null) {
    this.transitionService.playFullTransition(() => {
      this.drConfigService.selectedMode = mode;
      setTimeout(() => this.cdr.detectChanges(), 0); // Force DOM update in next tick
    });
  }

  // Goes back exactly one step: mode -> provider -> nothing.
  onBack() {
    if (this.selectedMode) {
      this.onModeSelected(null);
    } else {
      this.onProviderSelected(null);
    }
  }
}
