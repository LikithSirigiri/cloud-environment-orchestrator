import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subscriber } from 'rxjs';
import { Router, NavigationEnd, NavigationCancel, NavigationError } from '@angular/router';
import { filter } from 'rxjs/operators';

@Injectable({ providedIn: 'root' })
export class TransitionService {
  public isTransitioning$ = new BehaviorSubject<boolean>(false);

  constructor(private router: Router) {
    // Automatically open curtains after navigation finishes
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError)
    ).subscribe(() => {
      // Just a tiny 200ms buffer so the user sees the loader flash briefly
      setTimeout(() => {
        this.isTransitioning$.next(false);
      }, 200);
    });
  }

  playClosingCurtains(): Observable<void> {
    return new Observable((subscriber: Subscriber<void>) => {
      this.isTransitioning$.next(true);

      // Wait 250ms for curtains to fully close (CSS animation is 200ms)
      setTimeout(() => {
        subscriber.next();
        subscriber.complete();
      }, 250);
    });
  }

  // Use this for in-page transitions that don't involve the Angular Router
  playFullTransition(callback: () => void) {
    this.isTransitioning$.next(true);

    // Wait 250ms for curtains to close
    setTimeout(() => {
      try {
        // Execute the UI change behind closed curtains
        callback();
      } finally {
        // Small 200ms buffer before opening curtains
        setTimeout(() => {
          this.isTransitioning$.next(false);
        }, 200);
      }
    }, 250);
  }
}
