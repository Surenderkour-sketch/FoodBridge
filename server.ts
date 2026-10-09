import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '10mb' }));

// Initialize Google GenAI
const geminiApiKey = process.env.GEMINI_API_KEY;
const ai = geminiApiKey
  ? new GoogleGenAI({
      apiKey: geminiApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

// Helper to safely call Gemini with fallback
async function generateGeminiText(prompt: string, fallbackText: string): Promise<string> {
  if (!ai) {
    return fallbackText;
  }
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
    });
    return response.text || fallbackText;
  } catch (error) {
    console.warn('Gemini API call failed, using heuristic fallback:', error);
    return fallbackText;
  }
}

// 1. Suggest Food-Recipient Matches API
app.post('/api/gemini/suggest-matches', async (req, res) => {
  try {
    const { donation, recipients } = req.body;
    if (!donation || !recipients || !Array.isArray(recipients)) {
      return res.status(400).json({ error: 'Missing donation or recipients data' });
    }

    const prompt = `You are the AI Matchmaker for FoodBridge, a surplus food rescue platform connecting food donors (wedding halls, hotels, caterers) with care homes and shelters.
Task: Analyze this surplus donation and rank the best matching recipient organizations.

Donation details:
- Title: ${donation.foodName} (${donation.foodType})
- Servings / Quantity: ${donation.quantity}
- Diet: ${donation.dietType || 'Vegetarian/All'}
- Preparation Time: ${donation.prepTime}
- Available Until: ${donation.availableUntil}
- Donor Location: ${donation.pickupAddress}
- Donor Category: ${donation.donorType}

Potential Recipients:
${JSON.stringify(recipients.map((r: any) => ({
  id: r.id,
  name: r.name,
  type: r.type,
  capacity: r.capacity,
  currentNeed: r.currentNeed,
  dietaryPreference: r.dietaryPreference,
  address: r.address,
  distanceKm: r.distanceKm,
})), null, 2)}

Provide a JSON array inside a JSON object with this EXACT schema:
{
  "matches": [
    {
      "recipientId": "string",
      "matchScore": number (0-100),
      "priorityTier": "High" | "Medium" | "Low",
      "reasoning": "short explanation why this recipient is a great match",
      "dietaryFit": "High" | "Moderate",
      "recommendationTag": "Best Match" | "Capacity Match" | "Nearby Rescue"
    }
  ],
  "aiMatchSummary": "one or two encouraging sentences on why this donation creates meaningful impact"
}
Output pure valid JSON only, no markdown backticks.`;

    const fallbackResponse = JSON.stringify({
      matches: recipients.map((r: any, idx: number) => ({
        recipientId: r.id,
        matchScore: Math.max(95 - idx * 8, 65),
        priorityTier: idx === 0 ? 'High' : idx === 1 ? 'High' : 'Medium',
        reasoning: `Matches estimated capacity of ${r.capacity} people with ${donation.dietType || 'fresh'} food requirements.`,
        dietaryFit: 'High',
        recommendationTag: idx === 0 ? 'Best Match' : 'Capacity Match',
      })),
      aiMatchSummary: `Rescuing ${donation.foodName} directly satisfies immediate lunch/dinner requirements for vulnerable communities.`,
    });

    const rawText = await generateGeminiText(prompt, fallbackResponse);
    let parsed;
    try {
      const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(cleanJson);
    } catch {
      parsed = JSON.parse(fallbackResponse);
    }
    return res.json(parsed);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
});

// 2. Food Safety Check API
app.post('/api/gemini/food-safety-check', async (req, res) => {
  try {
    const { foodName, foodType, prepTimeHoursAgo, storageCondition, tempEstimate, packaging, isPerishable } = req.body;

    const prompt = `You are a certified Food Safety & Hygiene Inspector for FoodBridge.
Analyze this food donation for safety and suitability for donation to children's homes, shelters, and elder care homes.
Criteria:
- Hot cooked food kept at room temperature for over 4 hours is considered in the Danger Zone (unsafe).
- High-risk items (gravies, dairy, seafood, cut salads) need strict cold/hot chain.
- Packaging must be clean, food-grade, or sealed.
- Never recommend delivery for spoiled or unsafe food! If unsafe, safeToDeliver MUST be false.

Item data:
- Food: ${foodName} (${foodType})
- Prepared: ${prepTimeHoursAgo} hours ago
- Storage condition: ${storageCondition}
- Temperature note: ${tempEstimate || 'Room temperature'}
- Packaging: ${packaging}
- Perishable: ${isPerishable ? 'Yes' : 'No'}

Respond with pure JSON only in this format:
{
  "safeToDeliver": boolean,
  "safetyScore": number (0-100),
  "status": "APPROVED" | "CAUTION_REQUIRED" | "UNSAFE_REJECTED",
  "verdictTitle": "Short title",
  "keyObservations": ["point 1", "point 2"],
  "handlingReminders": ["reminder 1", "reminder 2"],
  "safeWindowRemainingHours": number,
  "recipientAdvisory": "Note for recipient when receiving this food"
}
Output pure valid JSON only, no markdown.`;

    // Rule-based fallback if Gemini is offline
    const hours = Number(prepTimeHoursAgo) || 2;
    const isRoomTemp = (storageCondition || '').toLowerCase().includes('room') || (storageCondition || '').toLowerCase().includes('ambient');
    const isDangerZone = hours >= 4.5 && isRoomTemp;

    const fallbackObj = {
      safeToDeliver: !isDangerZone,
      safetyScore: isDangerZone ? 30 : hours > 2.5 ? 75 : 95,
      status: isDangerZone ? 'UNSAFE_REJECTED' : hours > 2.5 ? 'CAUTION_REQUIRED' : 'APPROVED',
      verdictTitle: isDangerZone ? 'Exceeds Ambient Danger Window' : 'Safe for Prompt Volunteer Dispatch',
      keyObservations: isDangerZone
        ? ['Cooked meal left over 4 hours without active heating or refrigeration.', 'Bacterial growth risk elevated for vulnerable residents.']
        : ['Food prepared recently within standard food-safety shelf life.', 'Clean food-grade containers indicated.'],
      handlingReminders: [
        'Keep containers sealed during transit to prevent contamination.',
        'Transport in insulated delivery bags or clean covered crates.',
        'Advise recipient home to reheat to at least 74°C (165°F) before serving.',
      ],
      safeWindowRemainingHours: Math.max(0, 4 - hours),
      recipientAdvisory: 'Inspect aroma and container seals upon arrival. Consume within 2 hours of arrival.',
    };

    const rawText = await generateGeminiText(prompt, JSON.stringify(fallbackObj));
    let parsed;
    try {
      const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(cleanJson);
    } catch {
      parsed = fallbackObj;
    }
    return res.json(parsed);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
});

// 3. Food Handling Reminders API
app.post('/api/gemini/handling-reminders', async (req, res) => {
  try {
    const { foodName, foodType, quantity, transitMode } = req.body;

    const prompt = `You are the food safety officer for FoodBridge volunteer delivery runners.
Generate 4 concise, practical food handling reminders for delivering:
- Food: ${foodName} (${foodType})
- Quantity: ${quantity}
- Transit mode: ${transitMode || 'Two-wheeler / Car / Auto'}

Respond with pure JSON only:
{
  "reminders": [
    "string 1",
    "string 2",
    "string 3",
    "string 4"
  ],
  "temperatureGuidelines": "string",
  "deliveryWindowTip": "string"
}`;

    const fallback = {
      reminders: [
        'Keep food containers upright and secure to prevent spills during transit.',
        'Do not place hot food containers directly next to chilled items.',
        'Sanitize hands or use gloves when handing over food parcels.',
        'Confirm temperature and freshness with recipient kitchen supervisor on handover.',
      ],
      temperatureGuidelines: 'Keep hot food above 60°C (140°F) or chilled items below 5°C (41°F).',
      deliveryWindowTip: 'Target delivery completion within 45 minutes of pickup for optimum taste and nutritional quality.',
    };

    const rawText = await generateGeminiText(prompt, JSON.stringify(fallback));
    let parsed;
    try {
      const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(cleanJson);
    } catch {
      parsed = fallback;
    }
    return res.json(parsed);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
});

// 4. Community Impact Summary API
app.post('/api/gemini/impact-summary', async (req, res) => {
  try {
    const { metrics } = req.body;
    const prompt = `You are a social impact reporter for FoodBridge, celebrating community hunger relief and reducing banquet food waste.
Generate an inspiring community impact narrative report based on these real numbers:
- Total Meals Delivered: ${metrics?.mealsDelivered || 4250}
- Food Rescued: ${metrics?.kgRescued || 1840} kg
- Completed Rescue Missions: ${metrics?.completedDeliveries || 186}
- Active Volunteers: ${metrics?.activeVolunteers || 74}
- Care Homes / Shelters Supported: ${metrics?.careHomesSupported || 28}

Return pure JSON only:
{
  "headline": "inspiring 8-word headline",
  "summary": "2-3 sentences celebrating donors, volunteers, and shelters",
  "socialQuote": "a shareable motivational quote for the volunteers",
  "environmentalImpactText": "a statement explaining how saving this food reduced methane and CO2 equivalent footprint"
}`;

    const fallback = {
      headline: 'Together Turning Surplus Banquets Into Nourishing Smiles',
      summary: `Through ${metrics?.completedDeliveries || 186} dedicated rescue runs, FoodBridge has prevented ${metrics?.kgRescued || 1840} kg of pristine food from being discarded in landfills. Over ${metrics?.mealsDelivered || 4250} warm meals have reached orphanages and senior care homes.`,
      socialQuote: '"No banquet should go to waste while a single child or elder sleeps hungry." — FoodBridge Community',
      environmentalImpactText: `Rescuing ${metrics?.kgRescued || 1840} kg of cooked meals has avoided approximately ${(metrics?.kgRescued ? metrics.kgRescued * 2.5 : 4600).toFixed(0)} kg of CO₂ equivalent emissions from organic landfill decomposition.`,
    };

    const rawText = await generateGeminiText(prompt, JSON.stringify(fallback));
    let parsed;
    try {
      const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(cleanJson);
    } catch {
      parsed = fallback;
    }
    return res.json(parsed);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
});

// Vite middleware or static serving
async function startServer() {
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`FoodBridge server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
