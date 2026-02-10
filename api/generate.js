import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://sejvhzowjdtuvmrqrgkf.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNlanZoem93amR0dXZtcnFyZ2tmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzNzkyNDAsImV4cCI6MjA4NTk1NTI0MH0.ptPCW0i8OHkN847VwWYZGpWSKjtqUWuv_axw_yn9p6o";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function fillTemplate(template, vars) {
  let filled = template;
  for (const [key, value] of Object.entries(vars)) {
    filled = filled.replaceAll(`{${key}}`, value || "");
  }
  return filled;
}

async function fetchPrompt(promptId) {
  const { data, error } = await supabase
    .from("prompts")
    .select("prompt_text")
    .eq("prompt_id", promptId)
    .single();
  if (error) throw new Error(`Prompt ${promptId} not found: ${error.message}`);
  return data.prompt_text;
}

async function fetchSectorAnalysis(techName) {
  const { data, error } = await supabase
    .from("technology_sector_analyses")
    .select("content")
    .eq("technology_name", techName)
    .single();
  if (error) return "";
  return data.content;
}

async function fetchSectorProfile() {
  const { data, error } = await supabase
    .from("sector_profile")
    .select("organization_name, organization_context")
    .single();
  if (error) return { profile: "", organization_name: "" };

  return {
    profile: data.organization_context || "",
    organization_name: data.organization_name || "",
  };
}

async function buildPrompt(promptId, sessionData) {
  const template = await fetchPrompt(promptId);

  // Fetch technology × sector analyses and sector profile in parallel
  const [sectorAnalysisA, sectorAnalysisB, sectorProfileData] =
    await Promise.all([
      fetchSectorAnalysis(sessionData.technology_1),
      fetchSectorAnalysis(sessionData.technology_2),
      fetchSectorProfile(),
    ]);

  const vars = {
    // Session dimensions
    archetype: sessionData.archetype || "",
    dimension_a_value: sessionData.resource_outlook || "",
    dimension_b_value: sessionData.system_stability || "",
    nuance: sessionData.dominant_value || "",
    sector_name: sessionData.sector_name || "Energy",
    language: sessionData.language || "en",

    // Technology names
    tech_a_name: sessionData.technology_1 || "",
    tech_b_name: sessionData.technology_2 || "",

    // Sector profile (assembled from sector_profile table)
    sector_profile: sectorProfileData.profile,
    organization_name: sectorProfileData.organization_name,

    // Technology × sector analyses
    tech_x_sector_a: sectorAnalysisA,
    tech_x_sector_b: sectorAnalysisB,

    // Pipeline outputs
    b1_output: sessionData.seed_output || "",
    b2_output: sessionData.distant_future || "",
    b2_final_output: sessionData.distant_future || "",
    b3_fix_instructions: sessionData.b3_fix_instructions || "",
    b5_output: sessionData.not_so_distant_future || "",
    b6_output: sessionData.near_future || "",

    // User inputs
    user_intervention: sessionData.intervention_text || "",
  };

  let filled = fillTemplate(template, vars);

  // Append language instruction
  const langName = sessionData.language === "nl" ? "Dutch" : "English";
  filled += `\n\nIMPORTANT: Write your entire response in ${langName}.`;

  return filled;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { promptId, sessionId, sessionData } = req.body;

    if (!promptId || !sessionId || !sessionData) {
      return res.status(400).json({ error: "Missing promptId, sessionId, or sessionData" });
    }

    const prompt = await buildPrompt(promptId, sessionData);

    const apiKey = process.env.GEMINI_API_KEY;
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

    const result = await model.generateContentStream(prompt);

    // Set up streaming response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (error) {
    console.error("Generate error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
}
