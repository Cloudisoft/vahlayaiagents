// Industries and service opportunities are data, not code: add a row here to
// support a new industry or opportunity everywhere (search, filters, AI).

export interface Industry {
  key: string;
  label: string;
  group: string;
  query: string; // phrase used for text-search sources
  osm: string[]; // OpenStreetMap tag filters, e.g. 'craft=roofer' or 'shop~"car_repair|tyres"'
}

export const INDUSTRIES: Industry[] = [
  { key: "roofing", label: "Roofing", group: "Home services", query: "roofing contractor", osm: ["craft=roofer"] },
  { key: "plumbing", label: "Plumbing", group: "Home services", query: "plumber", osm: ["craft=plumber"] },
  { key: "hvac", label: "HVAC", group: "Home services", query: "HVAC contractor", osm: ["craft=hvac", 'craft="heating_engineer"'] },
  { key: "electrician", label: "Electricians", group: "Home services", query: "electrician", osm: ["craft=electrician"] },
  { key: "landscaping", label: "Landscaping", group: "Home services", query: "landscaping company", osm: ["craft=gardener", "landuse=plant_nursery"] },
  { key: "cleaning", label: "Cleaning services", group: "Home services", query: "cleaning service", osm: ["craft=cleaning", "shop=dry_cleaning"] },
  { key: "construction", label: "Construction", group: "Home services", query: "general contractor", osm: ["office=construction_company", "craft=builder", "craft=carpenter"] },
  { key: "dentist", label: "Dentists", group: "Healthcare", query: "dentist", osm: ["amenity=dentist", "healthcare=dentist"] },
  { key: "clinic", label: "Clinics & doctors", group: "Healthcare", query: "medical clinic", osm: ["amenity=clinic", "amenity=doctors", "healthcare=clinic", "healthcare=doctor"] },
  { key: "pharmacy", label: "Pharmacies", group: "Healthcare", query: "pharmacy", osm: ["amenity=pharmacy"] },
  { key: "veterinary", label: "Veterinary", group: "Healthcare", query: "veterinarian", osm: ["amenity=veterinary"] },
  { key: "fitness", label: "Gyms & fitness", group: "Healthcare", query: "gym", osm: ["leisure=fitness_centre"] },
  { key: "restaurant", label: "Restaurants", group: "Food & hospitality", query: "restaurant", osm: ["amenity=restaurant"] },
  { key: "cafe", label: "Cafés", group: "Food & hospitality", query: "cafe", osm: ["amenity=cafe"] },
  { key: "hotel", label: "Hotels", group: "Food & hospitality", query: "hotel", osm: ["tourism=hotel", "tourism=motel"] },
  { key: "auto_repair", label: "Auto repair", group: "Automotive", query: "auto repair shop", osm: ["shop=car_repair", "shop=tyres"] },
  { key: "car_dealer", label: "Car dealers", group: "Automotive", query: "car dealership", osm: ["shop=car"] },
  { key: "law", label: "Law firms", group: "Professional services", query: "law firm", osm: ["office=lawyer"] },
  { key: "accounting", label: "Accounting", group: "Professional services", query: "accounting firm", osm: ["office=accountant", "office=tax_advisor"] },
  { key: "real_estate", label: "Real estate", group: "Professional services", query: "real estate agency", osm: ["office=estate_agent"] },
  { key: "insurance", label: "Insurance", group: "Professional services", query: "insurance agency", osm: ["office=insurance"] },
  { key: "marketing", label: "Marketing agencies", group: "Professional services", query: "marketing agency", osm: ["office=advertising_agency", "office=marketing"] },
  { key: "it_services", label: "IT services", group: "Technology", query: "IT services company", osm: ["office=it", "office=telecommunication", "craft=computer"] },
  { key: "software", label: "Software companies", group: "Technology", query: "software company", osm: ["office=software", "office=company"] },
  { key: "retail", label: "Retail stores", group: "Retail", query: "store", osm: ["shop=clothes", "shop=gift", "shop=furniture", "shop=hardware"] },
  { key: "salon", label: "Salons & beauty", group: "Retail", query: "beauty salon", osm: ["shop=hairdresser", "shop=beauty"] },
  { key: "manufacturing", label: "Manufacturing", group: "Industrial", query: "manufacturer", osm: ["man_made=works", "industrial=factory"] },
  { key: "logistics", label: "Logistics & trucking", group: "Industrial", query: "trucking company", osm: ["office=logistics", "office=moving_company"] },
  { key: "education", label: "Schools & training", group: "Education", query: "training center", osm: ["amenity=language_school", "amenity=driving_school", "amenity=training"] },
  { key: "staffing", label: "Staffing agencies", group: "Professional services", query: "staffing agency", osm: ["office=employment_agency"] },
];

export const industryByKey = (k: string | null | undefined) => INDUSTRIES.find((i) => i.key === k) ?? null;

export interface Opportunity {
  key: string;
  label: string;
  hint: string; // what makes a business a good fit — given to the AI
}

export const OPPORTUNITIES: Opportunity[] = [
  { key: "website_development", label: "Website development", hint: "No website, an unreachable site, or an outdated/insecure/not mobile-friendly site." },
  { key: "seo_marketing", label: "SEO & digital marketing", hint: "Thin website content, no description, few or no social profiles." },
  { key: "crm", label: "CRM", hint: "Customer-facing business handling many leads, bookings or quotes, multiple locations or staff." },
  { key: "ai_agents", label: "AI agents (voice/chat)", hint: "Phone-heavy business: appointments, quotes, after-hours calls, high inbound call volume." },
  { key: "automation", label: "Workflow automation", hint: "Repetitive admin: scheduling, invoicing, intake forms, follow-ups." },
  { key: "saas", label: "SaaS products", hint: "Industry with established software categories (booking, practice management, dispatch)." },
  { key: "it_services", label: "IT services & support", hint: "Offices with several staff, regulated data (health, legal, finance), multiple locations." },
  { key: "recruitment", label: "Recruitment & staffing", hint: "Growing or multi-location businesses, high-turnover industries." },
  { key: "digital_transformation", label: "Digital transformation", hint: "Established businesses with little online presence or paper-based processes." },
  { key: "telecom", label: "Business phone & internet", hint: "Businesses relying on phone lines, multiple locations, customer calls." },
];

export const opportunityByKey = (k: string) => OPPORTUNITIES.find((o) => o.key === k) ?? null;
