/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    adminActor?: string;
    /** A cacheable page's report of its own render (G7-1-I4). */
    renderCache?: import('./server/cache/render.ts').RenderCacheReport;
  }
}
