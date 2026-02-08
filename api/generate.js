import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://sejvhzowjdtuvmrqrgkf.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNlanZoem93amR0dXZtcnFyZ2tmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzNzkyNDAsImV4cCI6MjA4NTk1NTI0MH0.ptPCW0i8OHkN847VwWYZGpWSKjtqUWuv_axw_yn9p6o";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Map prompt variable placeholders to session data fields
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

async function fetchTechDocument(techName) {
  const { data, error } = await supabase
    .from("technology_documents")
    .select("content")
    .eq("parent_tech", techName)
    .single();
  if (error) return "";
  return data.content;
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

// Build the full prompt with all variables filled in
async function buildPrompt(promptId, sessionData) {
  const template = await fetchPrompt(promptId);

  // Fetch tech docs and sector analyses for both technologies
  const [techDoc1, techDoc2, sectorAnalysis1, sectorAnalysis2] =
    await Promise.all([
      fetchTechDocument(sessionData.technology_1),
      fetchTechDocument(sessionData.technology_2),
      fetchSectorAnalysis(sessionData.technology_1),
      fetchSectorAnalysis(sessionData.technology_2),
    ]);

  const sectorProfile = [sectorAnalysis1, sectorAnalysis2]
    .filter(Boolean)
    .join("\n\n---\n\n");
  const techDocs = [techDoc1, techDoc2].filter(Boolean).join("\n\n---\n\n");

  const vars = {
    archetype: sessionData.archetype || "",
    resource_outlook: sessionData.resource_outlook || "",
    dimension_a_value: sessionData.resource_outlook || "",
    system_stability: sessionData.system_stability || "",
    dimension_b_value: sessionData.system_stability || "",
    dominant_value: sessionData.dominant_value || "",
    nuance: sessionData.dominant_value || "",
    technology_1: sessionData.technology_1 || "",
    technology_2: sessionData.technology_2 || "",
    tech_a_name: sessionData.technology_1 || "",
    tech_b_name: sessionData.technology_2 || "",
    sector_profile: sectorProfile,
    tech_docs: techDocs,
    technology_1_doc: techDoc1,
    technology_2_doc: techDoc2,
    technology_1_sector: sectorAnalysis1,
    technology_2_sector: sectorAnalysis2,
    tech_a_doc: techDoc1,
    tech_b_doc: techDoc2,
    tech_a_sector: sectorAnalysis1,
    tech_b_sector: sectorAnalysis2,
    b1_output: sessionData.seed_output || "",
    b2_scenario: sessionData.distant_future || "",
    b2_output: sessionData.distant_future || "",
    b5_scenario: sessionData.not_so_distant_future || "",
    b5_output: sessionData.not_so_distant_future || "",
    b6_scenario: sessionData.near_future || "",
    b6_output: sessionData.near_future || "",
    intervention_text: sessionData.intervention_text || "",
    user_intervention: sessionData.intervention_text || "",
    language: sessionData.language || "en",
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

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
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
