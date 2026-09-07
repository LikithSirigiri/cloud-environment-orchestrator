import { ApplicationConfig, importProvidersFrom, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { LucideAngularModule, LayoutGrid, Server, Cloud, Settings, HelpCircle, ChevronRight, ChevronLeft, Search, Bell, User, ChevronDown, Check, Folder, Network, Info, Eye, EyeOff, Monitor, List, Plus, Copy, Download, Save, ArrowRight, X, ShieldCheck, Database, Repeat, Code2, Terminal, Play, PlayCircle, Loader, ClipboardList, Trash2, Sun, Moon, LogOut, Ghost, Zap } from 'lucide-angular';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideHttpClient(),
    provideRouter(routes),
    importProvidersFrom(LucideAngularModule.pick({
      LayoutGrid, Server, Cloud, Settings, HelpCircle, ChevronRight, ChevronLeft, Search, Bell, User, ChevronDown, Check, Folder, Network, Info, Eye, EyeOff, Monitor, List, Plus, Copy, Download, Save, ArrowRight, X, ShieldCheck, Database, Repeat, Code2, Terminal, Play, PlayCircle, Loader, ClipboardList, Trash2, Sun, Moon, LogOut, Ghost, Zap
    }))
  ]
};
