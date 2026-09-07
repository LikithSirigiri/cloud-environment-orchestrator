import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map, tap, catchError, switchMap } from 'rxjs/operators';

import { environment } from '../../environments/environment';

export interface VmSize {
  name: string;
  displayName: string;
  vcpus: number;
  memoryGB: number;
  family: string;
  maxDataDisks: number;
  premiumSSD: boolean;
  hyperVGeneration: string;
  acceleratedNetworking: boolean;
  type: string;
  maxIops: string;
  localStorage: string;
}

interface CacheEntry {
  data: VmSize[];
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class AzureVmService {
  private cache = new Map<string, CacheEntry>();
  private readonly CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes

  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;
  
  private credentials: { subscriptionId: string, tenantId: string, clientId: string, clientSecret: string } | null = null;

  setCredentials(creds: any) {
    this.credentials = creds;
  }

  private getHeaders(): HttpHeaders {
    const authToken = localStorage.getItem('auth_token') || '';
    if (!this.credentials) {
      return new HttpHeaders({ Authorization: `Bearer ${authToken}` });
    }
    return new HttpHeaders({
      'x-azure-credentials': JSON.stringify(this.credentials),
      Authorization: `Bearer ${authToken}`
    });
  }

  constructor(private http: HttpClient) { }

  getVmSizes(subscriptionId: string, region: string): Observable<VmSize[]> {
    const cacheKey = `${subscriptionId}_${region}`;
    const cached = this.cache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp) < this.CACHE_DURATION_MS) {
      return of(cached.data);
    }

    const apiUrl = `/api/azure/skus?region=${region}`;
    const headers = this.getHeaders();

    return this.http.get<any>(apiUrl, { headers }).pipe(
      map(response => {
        const skus = response.value || [];
        return skus
          .filter((sku: any) => sku.resourceType === 'virtualMachines')
          .map((sku: any) => {
            const getCapability = (name: string) => sku.capabilities?.find((c: any) => c.name === name)?.value;

            const vcpus = parseInt(getCapability('vCPUs') || '0', 10);
            const memoryGB = parseInt(getCapability('MemoryGB') || '0', 10);
            const maxDataDisks = parseInt(getCapability('MaxDataDiskCount') || getCapability('MaxResourceVolumeMB') || '0', 10);
            const premiumSSD = getCapability('PremiumIO') === 'True';
            const hyperVGeneration = getCapability('HyperVGenerations') || 'Unknown';
            const acceleratedNetworking = getCapability('AcceleratedNetworkingEnabled') === 'True';

            // Format type based on family or name
            let type = 'General purpose';
            if (sku.family?.toLowerCase().includes('compute')) type = 'Compute optimized';
            else if (sku.family?.toLowerCase().includes('memory')) type = 'Memory optimized';
            else if (sku.family?.toLowerCase().includes('storage')) type = 'Storage optimized';
            else if (sku.family?.toLowerCase().includes('gpu')) type = 'GPU accelerated';

            // IOPS & Storage
            const iops = getCapability('UncachedDiskIOps') || getCapability('MaxResourceVolumeMB') || 'N/A';
            const storageMB = parseInt(getCapability('MaxResourceVolumeMB') || '0', 10);
            const storageGiB = storageMB > 0 ? Math.round(storageMB / 1024).toString() : 'N/A';

            return {
              name: sku.name,
              displayName: `${sku.name} - ${vcpus} vCPUs, ${memoryGB} GiB RAM`,
              vcpus,
              memoryGB,
              family: sku.family,
              maxDataDisks,
              premiumSSD,
              hyperVGeneration,
              acceleratedNetworking,
              type,
              maxIops: iops,
              localStorage: storageGiB
            };
          })
          .filter((vm: VmSize) => vm.vcpus > 0);
      }),
      tap((data: VmSize[]) => {
        this.cache.set(cacheKey, { data, timestamp: Date.now() });
      }),
      catchError(error => {
        console.error('Failed to fetch VM sizes', error);
        return of([]);
      })
    );
  }

  getDiskSizes(subscriptionId: string, region: string): Observable<string[]> {
    const fallbackSizes = [
      'Image default (30 GiB)',
      '32 GiB (P4)',
      '64 GiB (P6)',
      '128 GiB (P10)',
      '256 GiB (P15)',
      '512 GiB (P20)',
      '1 TiB (P30)',
      '2 TiB (P40)',
      '4 TiB (P50)',
      '8 TiB (P60)',
      '16 TiB (P70)',
      '32 TiB (P80)'
    ];
    const apiUrl = `/api/azure/skus?region=${region}`;
    const headers = this.getHeaders();

    return this.http.get<any>(apiUrl, { headers }).pipe(
      map(response => {
        const skus = response.value || [];
        // Check if Premium disks are available in this region
        const hasPremium = skus.some((sku: any) => sku.resourceType === 'disks' && sku.name === 'Premium_LRS');

        // Return standard Azure OS disk sizes matching Azure Portal exactly
        return hasPremium ? fallbackSizes : fallbackSizes.map((s: string) => s.replace(/ \(P\d+\)/, '')); // Strip P-tier if not premium, though usually standard sizes are the same GiB
      }),
      catchError(error => {
        console.error('Failed to fetch disk SKUs', error);
        return of(fallbackSizes);
      })
    );
  }

  getDiskTypes(subscriptionId: string, region: string): Observable<{ value: string, label: string }[]> {
    const fallbackTypes = [
      { value: 'Premium SSD', label: 'Premium SSD (locally-redundant storage)' },
      { value: 'Standard SSD', label: 'Standard SSD (locally-redundant storage)' },
      { value: 'Standard HDD', label: 'Standard HDD (locally-redundant storage)' }
    ];
    const apiUrl = `/api/azure/skus?region=${region}`;
    const headers = this.getHeaders();

    return this.http.get<any>(apiUrl, { headers }).pipe(
      map(response => {
        const skus = response.value || [];
        const diskSkus = skus.filter((sku: any) => sku.resourceType === 'disks').map((sku: any) => sku.name);
        const types: { value: string, label: string }[] = [];

        if (diskSkus.includes('Premium_LRS')) types.push({ value: 'Premium SSD', label: 'Premium SSD (locally-redundant storage)' });
        if (diskSkus.includes('Premium_ZRS')) types.push({ value: 'Premium SSD ZRS', label: 'Premium SSD (zone-redundant storage)' });
        if (diskSkus.includes('StandardSSD_LRS')) types.push({ value: 'Standard SSD', label: 'Standard SSD (locally-redundant storage)' });
        if (diskSkus.includes('StandardSSD_ZRS')) types.push({ value: 'Standard SSD ZRS', label: 'Standard SSD (zone-redundant storage)' });
        if (diskSkus.includes('Standard_LRS')) types.push({ value: 'Standard HDD', label: 'Standard HDD (locally-redundant storage)' });

        if (types.length === 0) return fallbackTypes;
        
        return types;
      }),
      catchError(error => {
        console.error('Failed to fetch disk types', error);
        return of(fallbackTypes);
      })
    );
  }
}
