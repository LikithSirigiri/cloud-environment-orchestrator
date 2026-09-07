import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PageTransitionComponent } from './components/page-transition.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, PageTransitionComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  title = 'azure-dr-ui';
}
