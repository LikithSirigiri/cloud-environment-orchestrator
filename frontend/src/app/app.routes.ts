import { Routes } from '@angular/router';
import { LoginComponent } from './components/login.component';
import { ManualLoginComponent } from './components/manual-login.component';
import { DashboardComponent } from './components/dashboard.component';
import { AuthCallbackComponent } from './components/auth-callback.component';
import { AdminComponent } from './components/admin.component';
import { ActivityComponent } from './components/activity.component';
import { AuthGuard } from './guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { TransitionResolver } from './services/transition.resolver';

export const routes: Routes = [
  { path: 'login', component: LoginComponent, resolve: { transition: TransitionResolver } },
  { path: 'login/manual', component: ManualLoginComponent },
  { path: 'auth/callback', component: AuthCallbackComponent },
  { path: 'dashboard', component: DashboardComponent, canActivate: [AuthGuard], resolve: { transition: TransitionResolver } },
  { path: 'activity', component: ActivityComponent, canActivate: [AuthGuard], resolve: { transition: TransitionResolver } },
  { path: 'admin', component: AdminComponent, canActivate: [AuthGuard, AdminGuard], resolve: { transition: TransitionResolver } },
  { path: '', redirectTo: '/dashboard', pathMatch: 'full' },
  { path: '**', redirectTo: '/dashboard' }
];
