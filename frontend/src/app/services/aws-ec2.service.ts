import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map, catchError, tap } from 'rxjs/operators';

// AWS equivalent of azure-vm.service.ts's SKU fetching — same region-scoped,
// 10-minute-cached pattern, backed by /api/aws/instance-types instead of
// /api/azure/skus.

interface CacheEntry {
  data: string[];
  timestamp: number;
}

// Shown while the real list is loading (or if the fetch fails) so the dropdown
// is never empty — not a silent default sent to the backend, just a starting
// point the user can already see and pick from before the real list arrives.
export const FALLBACK_INSTANCE_TYPES = ['t3.small', 't3.medium', 't3.large', 't3.xlarge', 't3.2xlarge'];

@Injectable({
  providedIn: 'root'
})
export class AwsEc2Service {
  private cache = new Map<string, CacheEntry>();
  private readonly CACHE_DURATION_MS = 10 * 60 * 1000;

  constructor(private http: HttpClient) {}

  getInstanceTypes(accessKeyId: string, secretAccessKey: string, region: string): Observable<string[]> {
    const cacheKey = `${accessKeyId}_${region}`;
    const cached = this.cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < this.CACHE_DURATION_MS) {
      return of(cached.data);
    }

    const authToken = localStorage.getItem('auth_token') || '';
    const headers = new HttpHeaders({
      'x-aws-credentials': JSON.stringify({ accessKeyId, secretAccessKey, region }),
      Authorization: `Bearer ${authToken}`
    });

    return this.http.get<any>(`/api/aws/instance-types?region=${encodeURIComponent(region)}`, { headers }).pipe(
      map(response => (response.instanceTypes as string[]) || []),
      tap((data: string[]) => this.cache.set(cacheKey, { data, timestamp: Date.now() })),
      catchError(error => {
        console.error('Failed to fetch EC2 instance types', error);
        return of(FALLBACK_INSTANCE_TYPES);
      })
    );
  }
}
