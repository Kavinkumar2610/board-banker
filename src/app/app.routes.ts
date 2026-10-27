import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./home/home.page').then(m => m.HomePage) },
  { path: 'create', loadComponent: () => import('./create/create.page').then(m => m.CreatePage) },
  { path: 'join', loadComponent: () => import('./join/join.page').then(m => m.JoinPage) },
  { path: 'join/:code', loadComponent: () => import('./join/join.page').then(m => m.JoinPage) },
  { path: 'game/:code', loadComponent: () => import('./game/game.page').then(m => m.GamePage) },
  { path: '**', redirectTo: '' },
];
