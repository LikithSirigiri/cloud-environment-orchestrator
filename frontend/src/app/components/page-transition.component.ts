import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TransitionService } from '../services/transition.service';

@Component({
  selector: 'app-page-transition',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="page-transition" [class.is-transitioning]="isTransitioning">
      <div class="overlay"></div>

      <div class="main-container">
        <svg class="loader" viewBox="0 0 240 160">
          <!-- Pins -->
          <g class="chip-pin">
            <line x1="110" y1="50" x2="110" y2="60" />
            <line x1="120" y1="50" x2="120" y2="60" />
            <line x1="130" y1="50" x2="130" y2="60" />
            <line x1="110" y1="100" x2="110" y2="110" />
            <line x1="120" y1="100" x2="120" y2="110" />
            <line x1="130" y1="100" x2="130" y2="110" />
            <line x1="90" y1="70" x2="100" y2="70" />
            <line x1="90" y1="80" x2="100" y2="80" />
            <line x1="90" y1="90" x2="100" y2="90" />
            <line x1="140" y1="70" x2="150" y2="70" />
            <line x1="140" y1="80" x2="150" y2="80" />
            <line x1="140" y1="90" x2="150" y2="90" />
          </g>

          <!-- Chip body -->
          <rect class="chip-body" x="100" y="60" width="40" height="40" />
          <text class="chip-text" x="120" y="84" text-anchor="middle">DR</text>

          <!-- Trace guides -->
          <path class="trace-bg" d="M60,0 L60,50 L110,50" />
          <path class="trace-bg" d="M240,40 L150,40 L150,70" />
          <path class="trace-bg" d="M180,160 L180,110 L130,110" />
          <path class="trace-bg" d="M0,100 L90,100 L90,90" />
          <path class="trace-bg" d="M180,0 L180,30 L130,30 L130,50" />

          <!-- Animated signal flow -->
          <path class="trace-flow yellow" d="M60,0 L60,50 L110,50" style="stroke-dasharray:18 300; stroke-dashoffset:118;" />
          <path class="trace-flow blue" d="M240,40 L150,40 L150,70" style="stroke-dasharray:22 360; stroke-dashoffset:142; animation-delay:-0.6s;" />
          <path class="trace-flow green" d="M180,160 L180,110 L130,110" style="stroke-dasharray:18 300; stroke-dashoffset:118; animation-delay:-1.2s;" />
          <path class="trace-flow purple" d="M0,100 L90,100 L90,90" style="stroke-dasharray:18 300; stroke-dashoffset:118; animation-delay:-1.8s;" />
          <path class="trace-flow red" d="M180,0 L180,30 L130,30 L130,50" style="stroke-dasharray:18 300; stroke-dashoffset:118; animation-delay:-2.4s;" />
        </svg>
      </div>
    </div>
  `,
  styles: [`
    /* From Uiverse.io by Vosoone, adapted for the app's route-transition overlay */

    .page-transition {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100vh;
      pointer-events: none; /* Let clicks pass through when inactive */
      z-index: 99998;
    }

    .is-transitioning {
      pointer-events: all; /* Block clicks during transition */
    }

    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(7, 5, 26, 0.8); /* Dark background matching theme, semi-transparent */
      backdrop-filter: blur(4px);
      z-index: 99999;
      opacity: 0;
      transition: opacity 0.2s ease-out;
    }

    .is-transitioning .overlay {
      opacity: 1;
    }

    .main-container {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 100000;
      display: flex;
      justify-content: center;
      align-items: center;
      opacity: 0;
      transition: opacity 0.2s ease-out;
    }

    .is-transitioning .main-container {
      opacity: 1;
    }

    .loader {
      width: 220px;
    }

    .trace-bg {
      stroke: #333;
      stroke-width: 1.8;
      fill: none;
    }

    .trace-flow {
      stroke-width: 1.8;
      fill: none;
      filter: drop-shadow(0 0 6px currentColor);
      animation: flow 3s cubic-bezier(0.5, 0, 0.9, 1) infinite;
    }

    .yellow { stroke: #ffea00; color: #ffea00; }
    .blue { stroke: #00ccff; color: #00ccff; }
    .green { stroke: #00ff15; color: #00ff15; }
    .purple { stroke: #9900ff; color: #9900ff; }
    .red { stroke: #ff3300; color: #ff3300; }

    @keyframes flow {
      to {
        stroke-dashoffset: 0;
      }
    }

    /* Chip */
    .chip-body {
      rx: 8;
      ry: 8;
      fill: #0f0d19;
      stroke: #00e4d0;
      stroke-width: 1.5;
    }

    /* Text inside the chip */
    .chip-text {
      font-size: 15px;
      font-weight: bold;
      letter-spacing: 1px;
      fill: #00e4d0;
      font-family: 'Inter', sans-serif;
    }

    /* Pins */
    .chip-pin {
      stroke: #666;
      stroke-width: 2;
      filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.6));
    }
  `]
})
export class PageTransitionComponent implements OnInit {
  isTransitioning = false;

  constructor(
    public transitionService: TransitionService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.transitionService.isTransitioning$.subscribe(val => {
      this.isTransitioning = val;
      this.cdr.detectChanges();
    });
  }
}
