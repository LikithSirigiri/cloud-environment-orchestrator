import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import { DrConfigService, DrStep } from '../services/dr-config.service';

@Component({
  selector: 'app-stepper',
  standalone: true,
  imports: [CommonModule, LucideAngularModule],
  templateUrl: './stepper.component.html',
  styleUrl: './stepper.component.css'
})
export class StepperComponent implements OnInit {
  steps: DrStep[] = [];

  constructor(private drConfigService: DrConfigService) {}

  ngOnInit() {
    this.drConfigService.steps$.subscribe(steps => {
      this.steps = steps;
    });
  }
}
