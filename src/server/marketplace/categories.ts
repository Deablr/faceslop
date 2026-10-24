// Marketplace categories (slugs verified against facebook.com). Pure. Port of legacy/src/server/fb/categories.ts.
//
// Each slug was checked live (logged out) at /marketplace/nyc/{slug}/ and returned a category
// feed with listings. Unknown slugs silently redirect to the nearby feed (search() turns that into
// BAD_REQUEST), so only add verified ones. Names follow Facebook's own category labels.
// Not offered: "propertyforsale" (Home Sales) redirects away in most regions; "home-goods",
// "sporting-goods", "pet-supplies", "musical-instruments", "home-improvement", "home-sales" are not
// real slugs (the real ones are below).
import '@tanstack/react-start/server-only';
import type { Category } from '@/shared/domain';

export const CATEGORIES: readonly Category[] = [
  // Facebook's top-level categories, in its own order
  { slug: 'vehicles', name: 'Vehicles' },
  { slug: 'propertyrentals', name: 'Property Rentals' },
  { slug: 'apparel', name: 'Apparel' },
  { slug: 'classifieds', name: 'Classifieds' },
  { slug: 'electronics', name: 'Electronics' },
  { slug: 'entertainment', name: 'Entertainment' },
  { slug: 'family', name: 'Family' },
  { slug: 'free', name: 'Free Stuff' },
  { slug: 'garden', name: 'Garden & Outdoor' },
  { slug: 'hobbies', name: 'Hobbies' },
  { slug: 'home', name: 'Home Goods' },
  { slug: 'home-improvements', name: 'Home Improvement Supplies' },
  { slug: 'instruments', name: 'Musical Instruments' },
  { slug: 'office-supplies', name: 'Office Supplies' },
  { slug: 'pets', name: 'Pet Supplies' },
  { slug: 'sports', name: 'Sporting Goods' },
  { slug: 'toys', name: 'Toys & Games' },
  // Popular subcategories
  { slug: 'bicycles', name: 'Bicycles' },
  { slug: 'furniture', name: 'Furniture' },
  { slug: 'cars', name: 'Cars' },
  { slug: 'motorcycles', name: 'Motorcycles' },
  { slug: 'video-games-consoles', name: 'Video Games & Consoles' },
];

const slugs = new Set(CATEGORIES.map((c) => c.slug));

export const isKnownCategory = (slug: string): boolean => slugs.has(slug);
