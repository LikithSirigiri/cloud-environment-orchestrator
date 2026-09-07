import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { LucideAngularModule } from 'lucide-angular';
import { AzureVmService, VmSize } from '../../services/azure-vm.service';

@Component({
  selector: 'app-vm-size-dropdown',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, LucideAngularModule],
  templateUrl: './vm-size-dropdown.component.html',
  styleUrl: './vm-size-dropdown.component.css'
})
export class VmSizeDropdownComponent implements OnChanges {
  @Input() subscriptionId?: string = '';
  @Input() region?: string = '';
  @Input() selectedValue?: string = '';
  @Output() selectedValueChange = new EventEmitter<string>();

  isOpen = false;
  isLoading = false;
  error = '';
  searchQuery = '';
  sortBy: 'name' | 'vcpus' | 'memory' | 'family' = 'vcpus';
  
  sizes: VmSize[] = [];
  filteredSizes: VmSize[] = [];
  selectedVm: VmSize | null = null;
  tempSelectedVm: VmSize | null = null; // Used in the modal before confirming

  // Pagination state
  currentPage = 1;
  pageSize = 50;

  constructor(private vmService: AzureVmService) {}

  ngOnChanges(changes: SimpleChanges) {
    if (changes['subscriptionId'] || changes['region']) {
      this.fetchSizes();
    }
    
    if (changes['selectedValue'] && this.selectedValue) {
      this.updateSelectedVm();
    }
  }

  toggleDropdown() {
    this.isOpen = !this.isOpen;
    if (this.isOpen) {
      this.tempSelectedVm = this.selectedVm; // Reset temp to current selected
      if (this.sizes.length === 0) {
        this.fetchSizes();
      }
    }
  }

  fetchSizes() {
    const subscriptionId = this.subscriptionId;
    const region = this.region;

    if (!subscriptionId || !region) {
      this.error = !subscriptionId
        ? 'Enter an Azure Subscription ID above before selecting a VM size.'
        : 'Select a region before selecting a VM size.';
      return;
    }

    this.isLoading = true;
    this.error = '';

    this.vmService.getVmSizes(subscriptionId, region).subscribe({
      next: (data) => {
        this.sizes = data;
        this.applyFilters();
        this.updateSelectedVm();
        this.isLoading = false;
      },
      error: (err) => {
        this.error = 'Unable to fetch VM sizes.';
        this.isLoading = false;
        console.error(err);
      }
    });
  }

  applyFilters() {
    let result = [...this.sizes];

    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      result = result.filter(vm => 
        vm.name.toLowerCase().includes(q) ||
        (vm.family || '').toLowerCase().includes(q) ||
        vm.vcpus.toString().includes(q) ||
        vm.memoryGB.toString().includes(q)
      );
    }

    result.sort((a, b) => {
      if (this.sortBy === 'name') return a.name.localeCompare(b.name);
      if (this.sortBy === 'vcpus') return a.vcpus - b.vcpus || a.memoryGB - b.memoryGB;
      if (this.sortBy === 'memory') return a.memoryGB - b.memoryGB || a.vcpus - b.vcpus;
      if (this.sortBy === 'family') return (a.family || '').localeCompare(b.family || '');
      return 0;
    });

    this.filteredSizes = result;
    this.currentPage = 1; // Reset to first page on filter
  }
  
  get totalPages(): number {
    return Math.ceil(this.filteredSizes.length / this.pageSize) || 1;
  }

  get paginatedSizes(): VmSize[] {
    const startIndex = (this.currentPage - 1) * this.pageSize;
    return this.filteredSizes.slice(startIndex, startIndex + this.pageSize);
  }

  nextPage() {
    if (this.currentPage < this.totalPages) {
      this.currentPage++;
    }
  }

  prevPage() {
    if (this.currentPage > 1) {
      this.currentPage--;
    }
  }

  confirmSelection() {
    if (this.tempSelectedVm) {
      this.selectSize(this.tempSelectedVm);
      this.isOpen = false;
    }
  }

  selectSize(vm: VmSize) {
    this.selectedVm = vm;
    this.selectedValue = vm.name;
    this.selectedValueChange.emit(this.selectedValue);
  }

  private updateSelectedVm() {
    if (this.sizes.length > 0 && this.selectedValue) {
      this.selectedVm = this.sizes.find(vm => vm.name === this.selectedValue) || null;
      if (this.isOpen) {
        this.tempSelectedVm = this.selectedVm;
      }
    }
  }

  closeDropdown() {
    this.isOpen = false;
  }
}
