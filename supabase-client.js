// supabase-client.js
// Shared across Login.html, volunteer_sign_up.html, organization_sign_up.html,
// Main_vol.html, Main_org.html.
// Fill these in from your Supabase project: Settings → API.
const SUPABASE_URL = "https://ojakrptuwdngewmuazgg.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HRKweLS7ovBiNtR8K7Un8g_q9Dn8kEV";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Checks the public.admins table for the current logged-in user (see
// today's migration — replaces the old hardcoded ADMIN_EMAILS array so
// there's exactly one place, the database, that knows who's an admin).
// Returns false if nobody's logged in, or on any query error.
async function isCurrentUserAdmin() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return false;

  const { data, error } = await supabaseClient
    .from('admins')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) {
    console.error('Admin check failed:', error.message);
    return false;
  }
  return !!data;
}

// Redirects an already-logged-in user away from login/signup pages,
// straight to their role's home page.
async function redirectIfLoggedIn() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return;

  if (await isCurrentUserAdmin()) {
    window.location.href = 'Admin_review.html';
    return;
  }

  const profile = await getCurrentProfile();
  window.location.href = (profile && profile.role === 'org') ? 'Main_org.html' : 'Main_vol.html';
}

// Guards a page that requires a session (e.g. Main_vol.html, Main_org.html).
// Returns the session, or redirects to login and returns null.
async function requireSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = "login.html";
    return null;
  }
  return session;
}

// Fetches the current user's profile. There's no single "profiles" table
// anymore — a user's row lives in either public.volunteers or
// public.organizations, and that's what determines their role. This checks
// volunteers first, then organizations, and tags the result with `role` so
// the rest of the app (Main_vol.html, Main_org.html, etc.) can keep using
// profile.role / profile.first_name / profile.org_name exactly as before.
async function getCurrentProfile() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return null;

  const { data: volunteer, error: volunteerError } = await supabaseClient
    .from("volunteers")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (volunteerError) {
    console.error("Failed to load volunteer profile:", volunteerError.message);
  }
  if (volunteer) return { ...volunteer, role: "volunteer" };

  const { data: org, error: orgError } = await supabaseClient
    .from("organizations")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (orgError) {
    console.error("Failed to load organization profile:", orgError.message);
  }
  if (org) return { ...org, role: "org" };

  console.error("No volunteer or organization row found for user:", user.id);
  return null;
}

async function signOut() {
  await supabaseClient.auth.signOut();
  window.location.href = "login.html";
}

// ------------------------------------------------------------
// Platform-wide stats — public aggregate counts (volunteer count,
// organization count, total logged hours) for the login page's brand
// panel. Backed by the get_platform_stats() Postgres function (see
// get_platform_stats.sql), which runs as SECURITY DEFINER so it can be
// called before anyone is signed in, while only ever returning
// aggregate numbers — never any individual row.
// ------------------------------------------------------------
async function getPlatformStats() {
  const { data, error } = await supabaseClient.rpc('get_platform_stats');
  if (error) {
    console.error("Failed to load platform stats:", error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    volunteerCount: Number(row.volunteer_count) || 0,
    organizationCount: Number(row.organization_count) || 0,
    totalHours: Number(row.total_hours) || 0,
  };
}

// ------------------------------------------------------------
// Байгууллагууд — the org directory, with each org's active job
// count and a category tag derived from its active opportunities
// (organizations don't have their own category column, so this
// uses whichever category shows up most often in their postings).
// ------------------------------------------------------------

const OPPORTUNITY_CATEGORY_LABELS = {
  education: "Боловсрол",
  environment: "Байгаль орчин",
  health: "Эрүүл мэнд",
  animals: "Амьтан хамгаалал",
  community: "Нийгэм",
  other: "Бусад",
};

// Fetches organizations (optionally filtered by name), joins in their
// active opportunities, and returns each org with a job count and a
// best-guess category label. Returns [] on error.
async function getOrganizationsDirectory(search = "") {
  let orgQuery = supabaseClient.from("organizations_public").select("id, org_name, about, city, verification_status, avatar_url, website, about_page");
  if (search && search.trim()) {
    orgQuery = orgQuery.ilike("org_name", `%${search.trim()}%`);
  }

  const { data: orgs, error: orgError } = await orgQuery.order("org_name");
  if (orgError) {
    console.error("Failed to load organizations:", orgError.message);
    return [];
  }
  if (!orgs || orgs.length === 0) return [];

  const { data: opps, error: oppError } = await supabaseClient
    .from("opportunities")
    .select("org_id, category")
    .eq("status", "active")
    .in("org_id", orgs.map(o => o.id));
  if (oppError) {
    console.error("Failed to load opportunity counts:", oppError.message);
  }

  const statsByOrg = {};
  for (const opp of (opps || [])) {
    const s = statsByOrg[opp.org_id] || (statsByOrg[opp.org_id] = { count: 0, byCategory: {} });
    s.count += 1;
    s.byCategory[opp.category] = (s.byCategory[opp.category] || 0) + 1;
  }

  return orgs.map(org => {
    const s = statsByOrg[org.id];
    let categoryLabel = "";
    if (s) {
      const topCategory = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1])[0][0];
      categoryLabel = OPPORTUNITY_CATEGORY_LABELS[topCategory] || "";
    }
    const about = normalizeAboutPage(org.about_page);
    return {
      id: org.id,
      orgName: org.org_name,
      about: org.about,
      city: org.city,
      jobCount: s ? s.count : 0,
      category: categoryLabel,
      verificationStatus: org.verification_status,
      avatarUrl: org.avatar_url,
      website: org.website,
      socialLinks: about.social_links,
    };
  });
}

// ------------------------------------------------------------
// Манай гишүүд — the org's view of everyone who has applied to
// any of its opportunities, plus the confirm → complete flow.
// ------------------------------------------------------------

// Fetches every application against the current org's opportunities,
// with the volunteer and opportunity joined in. Two queries (org's
// opportunity ids, then applications for those ids) instead of a
// nested filter, so it works reliably under RLS.
async function getOrgApplicants() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return [];

  const { data: opps, error: oppError } = await supabaseClient
    .from("opportunities")
    .select("id, title, hours_estimate, experience_required, experience_question, motivation_question")
    .eq("org_id", user.id);
  if (oppError) {
    console.error("Failed to load opportunities for applicants:", oppError.message);
    return [];
  }
  if (!opps || opps.length === 0) return [];

  const oppById = {};
  opps.forEach(o => { oppById[o.id] = o; });

  const { data: apps, error: appError } = await supabaseClient
    .from("applications")
    .select(`
      id,
      status,
      hours_logged,
      applied_at,
      opportunity_id,
      applicant_experience,
      applicant_motivation,
      volunteer:volunteers ( id, first_name, last_name, birthdate, phone, city, interests, about, avatar_url, instagram_url, facebook_url, workplace, education )
    `)
    .in("opportunity_id", opps.map(o => o.id))
    .order("applied_at", { ascending: false });
  if (appError) {
    console.error("Failed to load applicants:", appError.message);
    return [];
  }

  return (apps || []).map(a => ({ ...a, opportunity: oppById[a.opportunity_id] }));
}

// Fetches a single opportunity by id (RLS scopes writes to the owning org;
// this select is used by the per-job attendance/certificate page).
async function getOpportunityById(oppId) {
  const { data, error } = await supabaseClient
    .from("opportunities")
    .select("*")
    .eq("id", oppId)
    .single();
  if (error) {
    console.error("Failed to load opportunity:", error.message);
    return null;
  }
  return data;
}

// Fetches the current volunteer's own application (if any) for one
// specific opportunity — used by the opportunity detail page
// (Ajil_delgerengui.html) to show "Бүртгүүлэх" vs "✓ Бүртгүүлсэн"
// without having to load every opportunity like Main_vol.html does.
async function getMyApplicationForOpportunity(oppId) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabaseClient
    .from("applications")
    .select("id, status, hours_logged")
    .eq("opportunity_id", oppId)
    .eq("volunteer_id", user.id)
    .maybeSingle();
  if (error) {
    console.error("Failed to load my application:", error.message);
    return null;
  }
  return data;
}

// Fetches every application for one specific opportunity, with the
// volunteer joined in. Used by the per-job attendance/certificate page
// (as opposed to getOrgApplicants, which pulls every job at once).
async function getApplicantsForOpportunity(oppId) {
  const { data, error } = await supabaseClient
    .from("applications")
    .select(`
      id, status, hours_logged, applied_at, opportunity_id,
      applicant_experience, applicant_motivation,
      volunteer:volunteers ( id, first_name, last_name, birthdate, phone, city, interests, about, avatar_url, instagram_url, facebook_url, workplace, education )
    `)
    .eq("opportunity_id", oppId)
    .order("applied_at", { ascending: false });
  if (error) {
    console.error("Failed to load applicants for opportunity:", error.message);
    return [];
  }
  return data || [];
}

// Moves an application from pending to confirmed.
async function confirmApplication(applicationId) {
  const { error } = await supabaseClient
    .from("applications")
    .update({ status: "confirmed" })
    .eq("id", applicationId);
  if (error) throw error;
}

// Moves an application to cancelled — the org passing on a request,
// either straight from pending or reversing an earlier approval.
async function declineApplication(applicationId) {
  const { error } = await supabaseClient
    .from("applications")
    .update({ status: "cancelled" })
    .eq("id", applicationId);
  if (error) throw error;
}

// Marks an application completed and logs the hours the volunteer
// actually did.
async function completeApplication(applicationId, hoursLogged) {
  const { error } = await supabaseClient
    .from("applications")
    .update({ status: "completed", hours_logged: hoursLogged })
    .eq("id", applicationId);
  if (error) throw error;
}

// ------------------------------------------------------------
// Certificates — an org uploads one PNG certificate design; the
// app draws the volunteer's name onto it with the browser's own
// Canvas API, at a position the org configures, generated on
// demand. Nothing is pre-rendered or emailed — no extra library
// needed (no pdf-lib, no font embedding: canvas text already
// renders Cyrillic fine with any system/web font).
// ------------------------------------------------------------

const CERTIFICATE_BUCKET = "certificates";

// Fetches the given org's certificate template settings (storage path +
// where/how to place the volunteer's name). Returns null if the org
// hasn't uploaded one yet.
async function getCertificateTemplate(orgId) {
  const { data, error } = await supabaseClient
    .from("certificate_templates")
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("Failed to load certificate template:", error.message);
    return null;
  }
  return data;
}

// Uploads a new template PNG (or replaces the existing one, if `file` is
// given) for the current org, and saves the name placement/style settings.
async function saveCertificateTemplate({ file, xPercent, yPercent, fontSize, fontColor }) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const payload = {
    org_id: user.id,
    name_x: xPercent,
    name_y: yPercent,
    font_size: fontSize,
    font_color: fontColor,
    updated_at: new Date().toISOString(),
  };

  if (file) {
    const storagePath = `${user.id}/template.png`;
    const { error: uploadError } = await supabaseClient.storage
      .from(CERTIFICATE_BUCKET)
      .upload(storagePath, file, { upsert: true, contentType: "image/png" });
    if (uploadError) throw uploadError;
    payload.storage_path = storagePath;
  } else {
    // No new file this time (e.g. just nudging name position/font on an
    // already-saved template). The upsert below still needs a value for
    // storage_path — Postgres checks NOT NULL on the attempted INSERT
    // row before it ever looks at ON CONFLICT, so omitting it here would
    // fail even though a valid row already exists. Carry the existing
    // path forward.
    const existing = await getCertificateTemplate(user.id);
    if (!existing || !existing.storage_path) {
      throw new Error("Эхлээд загвар зургаа оруулна уу.");
    }
    payload.storage_path = existing.storage_path;
  }

  const { data, error } = await supabaseClient
    .from("certificate_templates")
    .upsert(payload, { onConflict: "org_id" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Public URL for a template's stored PNG. Pass `cacheBust` (e.g. an
// updated_at/issued_at timestamp) to force browsers/CDN to fetch the
// latest bytes instead of a cached copy from before a re-upload — the
// storage path itself never changes on re-upload (upsert to the same
// filename), so without this the old image can keep getting served.
function getCertificateTemplateUrl(storagePath, cacheBust) {
  const { data } = supabaseClient.storage.from(CERTIFICATE_BUCKET).getPublicUrl(storagePath);
  if (!data) return null;
  return cacheBust ? `${data.publicUrl}?v=${encodeURIComponent(cacheBust)}` : data.publicUrl;
}

// Loads an <img> from a URL (object URL or remote) as a Promise.
// crossOrigin is set so the canvas it gets drawn into stays
// "un-tainted" and can be exported with toBlob/toDataURL.
function _loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Загвар зургийг ачаалж чадсангүй."));
    img.src = src;
  });
}

// Draws `name` onto the given template image at the position/style in
// `template` (a row from certificate_templates — name_x/name_y are
// percentages of the image's width/height), and returns a PNG Blob.
async function _drawCertificate(img, name, template) {
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch (e) { /* ignore */ }
  }

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  const fontSize = Number(template.font_size) || 28;
  ctx.font = `600 ${fontSize}px "Golos Text", Arial, sans-serif`;
  ctx.fillStyle = template.font_color || "#1a1a1a";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const x = (Number(template.name_x) / 100) * canvas.width;
  const y = (Number(template.name_y) / 100) * canvas.height;
  ctx.fillText(name, x, y);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b); else reject(new Error("Зураг үүсгэхэд алдаа гарлаа."));
    }, "image/png");
  });

  // Callers (e.g. the template preview screen) expect an object with the
  // blob plus the metrics used to place the text, not a bare Blob.
  return {
    blob,
    pixelX: Math.round(x),
    pixelY: Math.round(y),
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    fontSize,
  };
}

// Stamps `name` onto a template PNG fetched from its public storage URL.
async function buildCertificateImage(templateUrl, name, template) {
  const img = await _loadImage(templateUrl);
  return _drawCertificate(img, name, template);
}

// Same as above, but from a local File (no upload) — used for the
// "preview before you save" step while an org is setting up a template.
async function buildCertificateImageFromFile(file, name, template) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await _loadImage(objectUrl);
    return await _drawCertificate(img, name, template);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// ------------------------------------------------------------
// Issuing certificates — once an org marks an application
// "completed", it can generate that volunteer's certificate from
// the org's saved template and store it, so the volunteer can
// find/download it later from their own dashboard.
// ------------------------------------------------------------

const CERTIFICATES_TABLE = "certificates";

// Generates a certificate PNG for a completed application, uploads it to
// Storage under the org's folder, and upserts a row in `certificates`
// (one per application — calling this again re-issues/overwrites it).
async function issueCertificate(applicationId) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const { data: app, error: appError } = await supabaseClient
    .from("applications")
    .select(`
      id, status, opportunity_id, hours_logged,
      volunteer:volunteers ( id, first_name, last_name ),
      opportunity:opportunities ( id, title, org_id, organization:organizations ( org_name ) )
    `)
    .eq("id", applicationId)
    .single();
  if (appError) throw appError;
  if (!app || app.status !== "completed") {
    throw new Error("Зөвхөн дууссан ажилд гэрчилгээ үүсгэнэ.");
  }

  const orgId = app.opportunity.org_id;
  const template = await getCertificateTemplate(orgId);
  if (!template) throw new Error("Энэ байгууллага гэрчилгээний загвар байршуулаагүй байна.");

  const fullName = [app.volunteer.first_name, app.volunteer.last_name].filter(Boolean).join(" ") || "Сайн дурын ажилтан";
  const templateUrl = getCertificateTemplateUrl(template.storage_path, template.updated_at);
  const result = await buildCertificateImage(templateUrl, fullName, template);

  const storagePath = `${orgId}/${app.volunteer.id}/${app.opportunity_id}.png`;
  const { error: uploadError } = await supabaseClient.storage
    .from(CERTIFICATE_BUCKET)
    .upload(storagePath, result.blob, { upsert: true, contentType: "image/png" });
  if (uploadError) throw uploadError;

  // org_name / opportunity_title / hours_logged are snapshotted here, at
  // issue time, so the certificate stays fully readable (and the
  // volunteer's hours stay intact) even if the org later deletes its
  // account or the opportunity is removed — see fix_certificate_cascade.sql,
  // which also switches these foreign keys from CASCADE to SET NULL so the
  // certificate row itself survives, and snapshot_certificate_hours.sql,
  // which adds the hours_logged column this relies on.
  const { data: certRow, error: certError } = await supabaseClient
    .from(CERTIFICATES_TABLE)
    .upsert({
      application_id: app.id,
      volunteer_id: app.volunteer.id,
      opportunity_id: app.opportunity_id,
      org_id: orgId,
      org_name: app.opportunity.organization ? app.opportunity.organization.org_name : null,
      opportunity_title: app.opportunity.title,
      hours_logged: app.hours_logged,
      storage_path: storagePath,
      issued_at: new Date().toISOString(),
    }, { onConflict: "application_id" })
    .select()
    .single();
  if (certError) throw certError;

  return { ...certRow, url: getCertificateTemplateUrl(storagePath, certRow.issued_at) };
}

// Fetches already-issued certificates for a set of application ids, so a
// list UI can show "download" vs "issue" per row without re-generating.
// Returns a map keyed by application_id.
async function getIssuedCertificates(applicationIds) {
  if (!applicationIds || applicationIds.length === 0) return {};
  const { data, error } = await supabaseClient
    .from(CERTIFICATES_TABLE)
    .select("application_id, storage_path, issued_at")
    .in("application_id", applicationIds);
  if (error) {
    console.error("Failed to load issued certificates:", error.message);
    return {};
  }
  const byApp = {};
  (data || []).forEach(c => { byApp[c.application_id] = c; });
  return byApp;
}

// Volunteer-side: every certificate issued to the current volunteer, with
// the opportunity + org name joined in, newest first. For a "Миний
// гэрчилгээ" list on the volunteer dashboard.
async function getMyCertificates() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabaseClient
    .from(CERTIFICATES_TABLE)
    .select(`
      id, application_id, storage_path, issued_at, org_name, opportunity_title, hours_logged,
      opportunity:opportunities!left ( id, title, organization:organizations!left ( org_name ) )
    `)
    .eq("volunteer_id", user.id)
    .order("issued_at", { ascending: false });
  if (error) {
    console.error("Failed to load certificates:", error.message);
    return [];
  }
  // Prefer the live opportunity/org name (reflects renames), but fall
  // back to what was snapshotted at issue time — this is what keeps a
  // certificate showing a real name instead of going blank once an org
  // deletes its account (see fix_certificate_cascade.sql).
  return (data || []).map(c => ({
    ...c,
    url: getCertificateTemplateUrl(c.storage_path, c.issued_at),
    displayOrgName: (c.opportunity && c.opportunity.organization && c.opportunity.organization.org_name) || c.org_name || "Байгууллага",
    displayOpportunityTitle: (c.opportunity && c.opportunity.title) || c.opportunity_title || "Ажил",
  }));
}

// Updates the current volunteer's own editable profile fields (name,
// phone, city, interests, about). Returns the updated row.
async function updateVolunteerProfile(fields) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const { data, error } = await supabaseClient
    .from("volunteers")
    .update(fields)
    .eq("id", user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Fetches every application belonging to the current volunteer, newest first,
// with the related opportunity (title, date, schedule) and organization
// (id + org_name) joined in. Returns [] on no session or on error.
async function getMyActivities() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabaseClient
    .from("applications")
    .select(`
      id,
      status,
      hours_logged,
      applied_at,
      opportunity:opportunities (
        id,
        title,
        event_date,
        schedule_note,
        is_recurring,
        hours_estimate,
        organization:organizations ( id, org_name, verification_status )
      )
    `)
    .eq("volunteer_id", user.id)
    .order("applied_at", { ascending: false });

  if (error) {
    console.error("Failed to load activities:", error.message);
    return [];
  }
  return data || [];
}

// Rolls the current volunteer's applications up into the numbers the
// hero stat-strip and sidebar progress card need: total logged hours,
// how many are still active (pending/confirmed), and how many are done.
// Cancelled applications are excluded from all three counts.
async function getMyHoursSummary() {
  const activities = await getMyActivities();
  const live = activities.filter(a => a.status !== "cancelled");

  const totalHours = live.reduce((sum, a) => sum + (Number(a.hours_logged) || 0), 0);
  const activeCount = live.filter(a => a.status === "pending" || a.status === "confirmed").length;
  const doneCount = live.filter(a => a.status === "completed").length;

  return { totalHours, activeCount, doneCount, activities: live };
}

// ------------------------------------------------------------
// Бусад сайн дурын ажлууд — browsing all open opportunities
// across every organization (read-only inspiration feed). Also
// usable later for the volunteer-facing job feed.
// ------------------------------------------------------------

// Fetches active opportunities from all orgs, with the posting
// organization's name joined in and a live applicant count from
// opportunity_stats. Optional title search and category filter.
async function getOpenOpportunities({ search = "", category = "" } = {}) {
  let query = supabaseClient
    .from("opportunities")
    .select(`
      id, title, description, category, location_type, location_label,
      is_recurring, event_date, schedule_note, hours_estimate,
      volunteers_needed, status, created_at,
      experience_required, experience_needed, benefits_provided, certificate_type,
      experience_question, motivation_question,
      organization:organizations ( id, org_name, verification_status )
    `)
    .eq("status", "active")
    .order("created_at", { ascending: false });

  if (category) query = query.eq("category", category);
  if (search && search.trim()) query = query.ilike("title", `%${search.trim()}%`);

  const { data: opps, error } = await query;
  if (error) {
    console.error("Failed to load opportunities:", error.message);
    return [];
  }
  if (!opps || opps.length === 0) return [];

  const { data: stats, error: statsError } = await supabaseClient
    .from("opportunity_stats")
    .select("*")
    .in("opportunity_id", opps.map(o => o.id));
  if (statsError) {
    console.error("Failed to load opportunity stats:", statsError.message);
  }
  const countsById = {};
  (stats || []).forEach(s => { countsById[s.opportunity_id] = s.applicant_count; });

  return opps.map(o => ({ ...o, applicant_count: countsById[o.id] || 0 }));
}
// ------------------------------------------------------------
// Verification — admin-only functions for reviewing organizations.
// Uses the same supabaseClient/session as the rest of the app, so
// RLS sees you as whichever user is currently logged in.
// ------------------------------------------------------------

// Fetches every org for the admin panel (all statuses, not just
// pending), so the admin page can show pending/verified/do-not-trust
// as separate tabs from one query.
async function getAllOrgsForAdmin() {
  const { data, error } = await supabaseClient
    .from("organizations")
    .select("*")
    .order("org_name");

  if (error) {
    console.error("Failed to load organizations for admin:", error.message);
    return [];
  }
  return data || [];
}

// Bans or unbans an org account. A banned org's own login is blocked
// in Login.html — this just flips the flag.
async function setBanned(orgId, banned) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    console.error("Not logged in — cannot update ban status");
    return null;
  }

  const { data, error } = await supabaseClient
    .from("organizations")
    .update({ banned })
    .eq("id", orgId)
    .select();

  if (error) {
    console.error("Ban update failed:", error.message);
    return null;
  }
  if (!data || data.length === 0) {
    console.error("Ban update affected 0 rows — likely blocked by an RLS policy.");
    return null;
  }
  return data;
}
// Fetches all orgs still pending review. (Superseded by
// getAllOrgsForAdmin for the tabbed admin page, kept here in case
// anything else still calls it.)
async function getPendingOrgs() {
  const { data, error } = await supabaseClient
    .from("organizations")
    .select("*")
    .eq("verification_status", "pending");

  if (error) {
    console.error("Failed to load pending orgs:", error.message);
    return [];
  }
  return data || [];
}

// Updates an org's verification status. Only succeeds if the
// currently logged-in user matches the RLS admin policy.
async function setVerification(orgId, status, notes = "") {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    console.error("Not logged in — cannot update verification status");
    return null;
  }

  const { data, error } = await supabaseClient
    .from("organizations")
    .update({
      verification_status: status, // 'verified' | 'rejected' | 'pending'
      verified_at: new Date().toISOString(),
      verified_by: user.id,
      verification_notes: notes,
    })
    .eq("id", orgId)
    .select();

  if (error) {
    console.error("Update failed:", error.message);
    return null;
  }
  if (!data || data.length === 0) {
    console.error("Update affected 0 rows — likely blocked by an RLS policy.");
    return null;
  }
  return data;
}
// Admin access is now controlled entirely by the public.admins table (see
// isCurrentUserAdmin() near the top of this file) plus matching RLS
// policies — to add a reviewer, insert a row into that table rather than
// editing code here.

// ------------------------------------------------------------
// Манай тухай — the org's editable about-page content (stored as
// one JSON blob on organizations.about_page) plus their avatar.
// ------------------------------------------------------------

// Fills in any missing keys so the page never has to null-check.
function normalizeAboutPage(raw) {
  return {
    founded_year: (raw && raw.founded_year) || '',
    focus_tags: (raw && raw.focus_tags) || [],
    paragraphs: (raw && raw.paragraphs) || [],
    mission: (raw && raw.mission) || '',
    social_links: (raw && raw.social_links) || [],
  };
}

// Saves any combination of the org's editable profile fields in one
// update: real columns like org_type / website, plus the about_page
// JSON blob. Pass only the keys you want to change, e.g.
//   updateOrgProfile({ org_type: 'ngo', website: 'https://...', about_page: {...} })
// Only works for the org's own row — RLS policy "org can update own
// row" requires auth.uid() = id.
async function updateOrgProfile(fields) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const { data, error } = await supabaseClient
    .from("organizations")
    .update(fields)
    .eq("id", user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Uploads a new profile picture to the org-avatars storage bucket
// (always overwriting the same path, so old images don't pile up),
// then saves the public URL onto the org's row. Returns the updated
// org row, so callers can read the new avatar_url straight back.
async function uploadOrgAvatar(file) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${user.id}/avatar.${ext}`;

  const { error: uploadError } = await supabaseClient
    .storage
    .from('org-avatars')
    .upload(path, file, { upsert: true, cacheControl: '3600' });
  if (uploadError) throw uploadError;

  const { data: urlData } = supabaseClient
    .storage
    .from('org-avatars')
    .getPublicUrl(path);

  // Cache-bust so the new image shows immediately even though the
  // path/filename didn't change.
  const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;

  const { data, error } = await supabaseClient
    .from("organizations")
    .update({ avatar_url: publicUrl })
    .eq("id", user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ------------------------------------------------------------
// Миний профайл — the volunteer's own avatar upload, mirroring
// uploadOrgAvatar above but writing to the volunteer-avatars bucket
// and the volunteers table.
// ------------------------------------------------------------

// Uploads a new profile picture to the volunteer-avatars storage bucket
// (always overwriting the same path, so old images don't pile up),
// then saves the public URL onto the volunteer's row. Returns the
// updated volunteer row, so callers can read the new avatar_url
// straight back.
// ------------------------------------------------------------
// Байгууллагын дэлгэрэнгүй профайл — public read-only view of one
// organization (opened by clicking a card in Baiguullaguud_org.html /
// Baiguullaguud_vol.html). Reuses the about_page JSON blob the org
// itself edits on Манай тухай.
// ------------------------------------------------------------

// Fetches one organization's public-safe columns (about_page, avatar_url,
// website, verification_status, etc.) by id, for volunteer/other-org
// viewers — NOT the org's own private fields like phone, need, or
// verification_notes (see organizations_public view). Returns null if
// not found. Orgs editing their own profile should use
// getCurrentProfile()/updateOrgProfile() instead, which read/write the
// real table under the org's own RLS policy.
async function getOrganizationById(orgId) {
  const { data, error } = await supabaseClient
    .from("organizations_public")
    .select("*")
    .eq("id", orgId)
    .maybeSingle();
  if (error) {
    console.error("Failed to load organization:", error.message);
    return null;
  }
  return data;
}

// Fetches one organization's currently active opportunities (for display
// on its public profile page), with a live applicant count from
// opportunity_stats — same shape as getOpenOpportunities but scoped to
// a single org_id instead of every org.
async function getOpportunitiesByOrg(orgId) {
  const { data: opps, error } = await supabaseClient
    .from("opportunities")
    .select(`
      id, title, description, category, location_type, location_label,
      is_recurring, event_date, schedule_note, hours_estimate,
      volunteers_needed, status, created_at
    `)
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("Failed to load organization's opportunities:", error.message);
    return [];
  }
  if (!opps || opps.length === 0) return [];

  const { data: stats, error: statsError } = await supabaseClient
    .from("opportunity_stats")
    .select("*")
    .in("opportunity_id", opps.map(o => o.id));
  if (statsError) {
    console.error("Failed to load opportunity stats:", statsError.message);
  }
  const countsById = {};
  (stats || []).forEach(s => { countsById[s.opportunity_id] = s.applicant_count; });

  return opps.map(o => ({ ...o, applicant_count: countsById[o.id] || 0 }));
}

// Permanently deletes the current user's account: removes the
// auth.users row via the delete_own_account() Postgres function (see
// delete_own_account.sql), which cascades to their public.volunteers
// or public.organizations row through the existing FK. Must only be
// called after re-authenticating the user (see the delete-account
// modal in Manai_tukhai.html / Profile_vol.html) — this is
// irreversible and there's no confirmation step below it.
async function deleteOwnAccount() {
  const { error } = await supabaseClient.rpc('delete_own_account');
  if (error) throw error;
}

// ------------------------------------------------------------
// Байгууллагыг мэдээлэх — lets any signed-in user (volunteer or org)
// flag another organization for admin review. Backed by the
// public.org_reports table (see org_reports.sql). Feeds the
// "Мэдээлсэн" tab in Admin_review.html.
// ------------------------------------------------------------

const REPORT_REASON_LABELS = {
  spam: 'Спам / хуурамч',
  scam: 'Луйвар / мөнгө шаардсан',
  inappropriate: 'Зохисгүй контент',
  no_show: 'Ажил зарлаад юу ч хийгээгүй',
  other: 'Бусад шалтгаан',
};

// Submits a report against an organization. Returns the inserted row,
// or null on failure (not logged in, or blocked by RLS).
async function reportOrganization(orgId, reason, details = "") {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    console.error("Not logged in — cannot submit report");
    return null;
  }

  const { data, error } = await supabaseClient
    .from("org_reports")
    .insert({
      org_id: orgId,
      reporter_id: user.id,
      reason,
      details,
    })
    .select()
    .single();

  if (error) {
    console.error("Report submission failed:", error.message);
    return null;
  }
  return data;
}

// Submits a report against a specific opportunity/event (also stores
// the owning org_id so admin can still filter/group by organization).
// Returns the inserted row, or null on failure.
async function reportOpportunity(opportunityId, orgId, reason, details = "") {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    console.error("Not logged in — cannot submit report");
    return null;
  }

  const { data, error } = await supabaseClient
    .from("org_reports")
    .insert({
      org_id: orgId,
      opportunity_id: opportunityId,
      reporter_id: user.id,
      reason,
      details,
    })
    .select()
    .single();

  if (error) {
    console.error("Report submission failed:", error.message);
    return null;
  }
  return data;
}

// Admin: fetches every report with the reported org's name/status and
// (when the report targets a specific event) the opportunity's title
// joined in, newest first.
async function getAllReportsForAdmin() {
  const { data, error } = await supabaseClient
    .from("org_reports")
    .select(`
      id, reason, details, status, created_at, resolved_at, resolved_notes,
      organization:organizations ( id, org_name, verification_status, banned ),
      opportunity:opportunities ( id, title )
    `)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to load reports for admin:", error.message);
    return [];
  }
  return data || [];
}

// Admin: marks a report resolved, dismissed, or reopened, with
// optional notes. Only succeeds if the logged-in user matches the
// RLS admin policy.
async function resolveReport(reportId, status, notes = "") {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    console.error("Not logged in — cannot update report");
    return null;
  }

  const { data, error } = await supabaseClient
    .from("org_reports")
    .update({
      status, // 'resolved' | 'dismissed' | 'open'
      resolved_at: status === 'open' ? null : new Date().toISOString(),
      resolved_by: user.id,
      resolved_notes: notes,
    })
    .eq("id", reportId)
    .select();

  if (error) {
    console.error("Report update failed:", error.message);
    return null;
  }
  if (!data || data.length === 0) {
    console.error("Report update affected 0 rows — likely blocked by an RLS policy.");
    return null;
  }
  return data;
}

// ------------------------------------------------------------
// Санал хүсэлт — public feedback submissions from the Intro page's
// modal. Anyone can submit, logged in or not (see feedback.sql for
// the RLS policy allowing anonymous inserts). Only the admin
// account(s) can read/update — feeds the "Санал хүсэлт" tab in
// Admin_review.html.
// ------------------------------------------------------------

// Submits one feedback entry. Works whether or not the visitor is
// logged in.
async function submitFeedback({ name, email, message }) {
  // No .select() here on purpose: anonymous visitors have no SELECT
  // policy on feedback (only admins do), and asking Postgres to hand
  // the inserted row back (RETURNING) requires passing a SELECT check
  // too — even though the INSERT itself is allowed. Without .select(),
  // no RETURNING is requested, so this only needs the INSERT policy.
  const { error } = await supabaseClient
    .from("feedback")
    .insert({ name, email, message });
  if (error) throw error;
}

// Admin: fetches every feedback submission, newest first.
async function getAllFeedbackForAdmin() {
  const { data, error } = await supabaseClient
    .from("feedback")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("Failed to load feedback:", error.message);
    return [];
  }
  return data || [];
}

// Admin: marks a feedback entry new/read/archived.
async function updateFeedbackStatus(feedbackId, status) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    console.error("Not logged in — cannot update feedback status");
    return null;
  }

  const { data, error } = await supabaseClient
    .from("feedback")
    .update({ status })
    .eq("id", feedbackId)
    .select();

  if (error) {
    console.error("Feedback status update failed:", error.message);
    return null;
  }
  if (!data || data.length === 0) {
    console.error("Feedback update affected 0 rows — likely blocked by an RLS policy.");
    return null;
  }
  return data;
}

async function uploadVolunteerAvatar(file) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${user.id}/avatar.${ext}`;

  const { error: uploadError } = await supabaseClient
    .storage
    .from('volunteer-avatars')
    .upload(path, file, { upsert: true, cacheControl: '3600' });
  if (uploadError) throw uploadError;

  const { data: urlData } = supabaseClient
    .storage
    .from('volunteer-avatars')
    .getPublicUrl(path);

  // Cache-bust so the new image shows immediately even though the
  // path/filename didn't change.
  const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;

  const { data, error } = await supabaseClient
    .from("volunteers")
    .update({ avatar_url: publicUrl })
    .eq("id", user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}
// ------------------------------------------------------------
// Ажлын зураг — lets an org attach one PNG photo to a single job
// posting (public.opportunities.image_url), shown on the job's
// detail page (Ajil_delgerengui.html). Stored in the public
// "opportunity-images" bucket at "<org_id>/<opportunity_id>.png"
// (upsert on re-upload), so RLS can scope writes to the folder
// matching auth.uid(). See opportunity_images.sql for the column,
// bucket, and storage policies this depends on.
// ------------------------------------------------------------

const OPPORTUNITY_IMAGE_BUCKET = "opportunity-images";

// Uploads (or replaces) the PNG photo for one of the current org's
// opportunities, saves the public URL onto that opportunity's row,
// and returns the updated row. `oppId` must already exist (insert
// the opportunity first if it's brand new — see Main_org.html).
async function uploadOpportunityImage(oppId, file) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const path = `${user.id}/${oppId}.png`;

  const { error: uploadError } = await supabaseClient
    .storage
    .from(OPPORTUNITY_IMAGE_BUCKET)
    .upload(path, file, { upsert: true, cacheControl: '3600', contentType: 'image/png' });
  if (uploadError) throw uploadError;

  const { data: urlData } = supabaseClient
    .storage
    .from(OPPORTUNITY_IMAGE_BUCKET)
    .getPublicUrl(path);

  // Cache-bust so the new image shows immediately even though the
  // path/filename didn't change.
  const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;

  const { data, error } = await supabaseClient
    .from("opportunities")
    .update({ image_url: publicUrl })
    .eq("id", oppId)
    .eq("org_id", user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Removes the photo from one of the current org's opportunities: best-effort
// delete of the storage file, then clears image_url on the row. Returns the
// updated row.
async function removeOpportunityImage(oppId) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error("Нэвтрээгүй байна.");

  const path = `${user.id}/${oppId}.png`;
  const { error: removeError } = await supabaseClient.storage.from(OPPORTUNITY_IMAGE_BUCKET).remove([path]);
  if (removeError) {
    // Not fatal — the row update below is what actually controls whether
    // the photo shows up anywhere, so just log and carry on.
    console.error("Failed to delete opportunity image file:", removeError.message);
  }

  const { data, error } = await supabaseClient
    .from("opportunities")
    .update({ image_url: null })
    .eq("id", oppId)
    .eq("org_id", user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}
