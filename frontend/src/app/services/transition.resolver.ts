import { Injectable } from '@angular/core';
import { Resolve } from '@angular/router';
import { TransitionService } from './transition.service';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable({ providedIn: 'root' })
export class TransitionResolver implements Resolve<boolean> {
  constructor(private transitionService: TransitionService) {}

  resolve(): Observable<boolean> {
    // Wait for the closing curtains to finish before resolving true to allow navigation
    return this.transitionService.playClosingCurtains().pipe(
      map(() => true)
    );
  }
}
