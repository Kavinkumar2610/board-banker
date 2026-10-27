import { Component, computed, input } from '@angular/core';
import { TOKENS } from '../money';

/** A player's initial on their seat colour. Decorative: the name is always shown next to it. */
@Component({
  selector: 'app-avatar',
  template: '{{ initial() }}',
  host: {
    class: 'avatar',
    'aria-hidden': 'true',
    '[class.sm]': "size() === 'sm'",
    '[class.lg]': "size() === 'lg'",
    '[style.background]': 'token().bg',
    '[style.color]': 'token().fg',
  },
})
export class Avatar {
  readonly name = input.required<string>();
  readonly color = input(0);
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  protected readonly token = computed(() => TOKENS[this.color() % TOKENS.length]);
  protected readonly initial = computed(() => Array.from(this.name().trim())[0]?.toUpperCase() ?? '?');
}
