/* ============================================================================
   report-client.js
   ----------------------------------------------------------------------------
   Defines reportOpportunity(), which Ajil_delgerengui.html's report modal
   already calls but which didn't exist anywhere — that's why the "reports"
   table wasn't there yet either. Include this AFTER supabase-client.js,
   only on pages that need it (currently just Ajil_delgerengui.html).

   Requires the `reports` table from supabase_schema_notifications.sql.
   ============================================================================ */

async function reportOpportunity(opportunityId, orgId, reason, details) {
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return false;

    const { error } = await supabaseClient
      .from('reports')
      .insert([{
        opportunity_id: opportunityId,
        org_id: orgId,
        reporter_id: user.id,
        reason: reason,
        details: details || null
      }]);

    if (error) throw error;
    return true;
  } catch (err) {
    console.error('reportOpportunity failed:', err);
    return false;
  }
}
