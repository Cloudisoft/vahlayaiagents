import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test";
const { nameKey, normalizeWebsite, normalizePhone, normalizeState, normalizeZip } = await import("../src/leadgen/engine/normalize.js");
const { normalizeRecord, storeRecord } = await import("../src/leadgen/engine/store.js");
const { locationMatch, scoreLead, mustHaveFailures } = await import("../src/leadgen/engine/qualify.js");
const { parseSite, assertPublicUrl, completeness } = await import("../src/leadgen/engine/enrich.js");
const { buildOverpassQuery } = await import("../src/leadgen/engine/sources/osm.js");
const { pool } = await import("../src/db/pool.js");

test("names, websites, phones and addresses normalize without inventing anything", () => {
  assert.equal(nameKey("The Roofing Guy, LLC"), nameKey("roofing guy"));
  assert.equal(nameKey("Smith & Sons Plumbing Inc."), nameKey("smith sons plumbing"));
  assert.deepEqual(normalizeWebsite("www.Example.com/?utm_source=x#top"), { website: "https://www.example.com", domain: "example.com", social: null });
  assert.equal(normalizeWebsite("https://facebook.com/kiddroofing").website, null, "a Facebook page is not a website");
  assert.equal(normalizeWebsite("https://facebook.com/kiddroofing").social, "https://facebook.com/kiddroofing");
  assert.equal(normalizeWebsite("not a url").website, null);
  assert.deepEqual(normalizePhone("+1-512-477-7827"), { e164: "+15124777827", valid: true, reason: null });
  assert.equal(normalizePhone("(512) 555-0123").valid, false, "555 numbers are fictional");
  assert.equal(normalizePhone("+1 212 555 1212").valid, false, "directory assistance is not a business line");
  assert.equal(normalizePhone("123").e164, null);
  assert.equal(normalizePhone("020 7946 0958", "GB").e164, null, "no country code outside US/CA → not guessed");
  assert.equal(normalizePhone("+44 20 7946 0958", "GB").e164, "+442079460958");
  assert.equal(normalizeState("Texas"), "TX");
  assert.equal(normalizeZip("78701-1234"), "78701");
});

test("a source record maps to normalized fields with notes for what couldn't be used", () => {
  const { n, notes } = normalizeRecord({ sourceRef: "x", sourceUrl: null, raw: {}, fields: { businessName: "  Kidd  Roofing ", phone: "12", website: "instagram.com/kidd", city: "AUSTIN", state: "Texas" } });
  assert.equal(n.business_name, "Kidd Roofing");
  assert.equal(n.main_phone_e164, null);
  assert.ok(notes.main_phone);
  assert.equal(n.website, null);
  assert.deepEqual(n.social_urls, ["https://instagram.com/kidd"]);
  assert.equal(n.city, "Austin");
  assert.equal(n.state, "TX");
});

test("website parsing finds real contacts and signals", () => {
  const html = `<html><head><title>Kidd Roofing | Austin</title><meta name="description" content="Family roofers since 1990"><meta name="viewport" content="width=device-width"><meta name="generator" content="WordPress 6.4"></head>
  <body><a href="mailto:info@kiddroof.com">Email</a> <a href="tel:+15126717791">Call</a> img@2x.png sentry@sentry.io
  <a href="https://www.facebook.com/kiddroofing/">fb</a> <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
  <a href="/contact-us">Contact</a> © 2019 Kidd Roofing</body></html>`;
  const p = parseSite(html, "https://kiddroof.com");
  assert.deepEqual(p.emails, ["info@kiddroof.com"]);
  assert.deepEqual(p.tels, ["+15126717791"]);
  assert.deepEqual(p.social, ["https://www.facebook.com/kiddroofing"]);
  assert.equal(p.description, "Family roofers since 1990");
  assert.equal(p.viewport, true);
  assert.equal(p.generator, "WordPress 6.4");
  assert.equal(p.copyrightYear, 2019);
  assert.equal(p.contactUrl, "https://kiddroof.com/contact-us");
  assert.ok(parseSite("<p>This domain is for sale</p>", "https://x.com").parked);
});

test("server never fetches private addresses", async () => {
  for (const u of ["http://127.0.0.1/", "http://169.254.169.254/latest", "http://10.0.0.5/", "http://[::1]/", "file:///etc/passwd", "http://example.com:22/"]) {
    await assert.rejects(assertPublicUrl(u), undefined, u);
  }
});

test("location match, must-haves and lead score", () => {
  const locs = [{ country: "US", state: "TX", city: "Austin" }];
  assert.equal(locationMatch({ city: "Austin", state: "TX", country: "US" }, locs).score, 100);
  assert.equal(locationMatch({ city: "Round Rock", state: "TX", country: "US" }, locs).score, 60);
  assert.equal(locationMatch({ city: "Denver", state: "CO", country: "US" }, locs).score, 0);
  assert.equal(locationMatch({ country: "US" }, locs).score, 50);
  const c = { industry: null, keywords: "", services: "", locations: locs, website: "has", requirePhone: true, requireEmail: false, size: "any", opportunities: [], idealCustomer: "", qualifyThreshold: 70 } as const;
  assert.deepEqual(mustHaveFailures({ website: null, validation: { phone: { valid: true } } }, c as any, false), ["No working website (required)"]);
  assert.deepEqual(mustHaveFailures({ website: "https://a.com", website_status: "ok", validation: { phone: { valid: true } } }, c as any, false), []);
  assert.equal(scoreLead({ fit: 80, industry: 100, location: 100, completeness: 70, topOpportunity: 90 }), 88);
  assert.equal(completeness({ business_name: "a", main_phone_e164: "+1", business_email: "x@y.z" }), 50);
});

test("overpass query uses the industry tags and keyword names", () => {
  const q = buildOverpassQuery({ industry: "roofing", keywords: "metal roof, gutters", location: { city: "Austin", state: "TX" } }, { areaId: 3600113314, bbox: [1, 2, 3, 4], label: "Austin" });
  assert.match(q, /area\(id:3600113314\)->\.a/);
  assert.match(q, /\["craft"="roofer"\]\["name"\]/);
  assert.match(q, /\["name"~"metal roof\|gutters",i\]/);
});

test("de-duplication merges the same business but keeps separate branches", async () => {
  const org = (await pool.query("select id from organizations limit 1")).rows[0].id;
  const job = (await pool.query("insert into discovery_jobs (organization_id, name, criteria, sources) values ($1,'test','{}','{osm}') returning id", [org])).rows[0].id;
  const rec = (ref: string, f: Record<string, unknown>) => ({ sourceRef: ref, sourceUrl: null, raw: { ref }, fields: { businessName: "Zzq Test Roofers", city: "Testville", state: "TX", ...f } });
  try {
    const a = await storeRecord({ organizationId: org, jobId: job, source: "osm", record: rec("t1", { phone: "+1 512 555 0100", address: "1 Main St" }), leadListId: null });
    const sameAgain = await storeRecord({ organizationId: org, jobId: job, source: "google_places", record: rec("g1", { phone: "(512) 555-0100", website: "zzqroof.com" }), leadListId: null });
    const branch = await storeRecord({ organizationId: org, jobId: job, source: "osm", record: rec("t2", { phone: "+1 512 555 0199", address: "900 Other Rd" }), leadListId: null });
    assert.ok(a?.isNew);
    assert.equal(sameAgain?.leadId, a?.leadId, "same phone → same lead");
    assert.equal(sameAgain?.matchedBy, "same phone");
    assert.notEqual(branch?.leadId, a?.leadId, "different phone and address → another branch");
    const lead = (await pool.query("select website, sources, field_meta from leads where id = $1", [a!.leadId])).rows[0];
    assert.equal(lead.website, "https://zzqroof.com", "blank field filled from the second source");
    assert.equal(lead.field_meta.website.source, "google_places");
    assert.deepEqual(lead.sources.sort(), ["google_places", "osm"]);
    assert.equal(Number((await pool.query("select count(*) from lead_source_records where lead_id = $1", [a!.leadId])).rows[0].count), 2, "both raw records kept");
  } finally {
    await pool.query("delete from leads where organization_id = $1 and name_key = $2", [org, "zzq test roofers"]);
    await pool.query("delete from discovery_jobs where id = $1", [job]);
  }
});
