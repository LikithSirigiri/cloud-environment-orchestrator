import { Component, Input, Output, EventEmitter, ElementRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';

// Small fixed-cardinality dropdowns only (Environment, DB Node Count) — a real
// value-picker built around the Uiverse.io "popup" burger-menu pattern the user
// asked for, driven by Angular state instead of the raw checkbox-sibling-selector
// trick the original snippet used (more robust once wrapped in a component, and
// lets it close on an outside click). Deliberately NOT used for the Instance Type
// dropdowns — those can hold hundreds of AWS-fetched options, which this
// button-list shape can't reasonably present; those stay native <select>s reskinned
// to match this component's palette instead (see aws-new-environment-form's CSS).
export interface PopupSelectOption {
  value: any;
  label: string;
}

@Component({
  selector: 'app-popup-select',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './popup-select.component.html',
  styleUrl: './popup-select.component.css'
})
export class PopupSelectComponent {
  @Input() options: PopupSelectOption[] = [];
  @Input() value: any;
  @Input() placeholder = 'Select…';
  @Output() valueChange = new EventEmitter<any>();

  isOpen = false;

  constructor(private elementRef: ElementRef) {}

  get selectedLabel(): string {
    const match = this.options.find(o => o.value === this.value);
    return match ? match.label : this.placeholder;
  }

  toggle() {
    this.isOpen = !this.isOpen;
  }

  select(opt: PopupSelectOption) {
    this.value = opt.value;
    this.valueChange.emit(opt.value);
    this.isOpen = false;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (this.isOpen && !this.elementRef.nativeElement.contains(event.target)) {
      this.isOpen = false;
    }
  }
}
