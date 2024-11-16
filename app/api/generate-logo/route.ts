import { clerkClient, currentUser } from "@clerk/nextjs/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import dedent from "dedent";
import Together from "together-ai";
import { z } from "zod";

let ratelimit: Ratelimit | undefined;

export async function POST(req: Request) {
  const user = await currentUser();

  if (!user) {
    return new Response("", { status: 404 });
  }

  const json = await req.json();
  const data = z
    .object({
      userAPIKey: z.string().optional(),
      companyName: z.string(),
      // selectedLayout: z.string(),
      selectedStyle: z.string(),
      selectedPrimaryColor: z.string(),
      selectedBackgroundColor: z.string(),
      additionalInfo: z.string().optional(),
    })
    .parse(json);

  // Add observability if a Helicone key is specified, otherwise skip
  const options: ConstructorParameters<typeof Together>[0] = {};
  if (process.env.HELICONE_API_KEY) {
    options.baseURL = "https://together.helicone.ai/v1";
    options.defaultHeaders = {
      "Helicone-Auth": `Bearer ${process.env.HELICONE_API_KEY}`,
      "Helicone-Property-LOGOBYOK": data.userAPIKey ? "true" : "false",
    };
  }

  // Add rate limiting if Upstash API keys are set & no BYOK, otherwise skip
  if (process.env.UPSTASH_REDIS_REST_URL && !data.userAPIKey) {
    ratelimit = new Ratelimit({
      redis: Redis.fromEnv(),
      // Allow 3 requests per 2 months on prod
      limiter: Ratelimit.fixedWindow(3, "60 d"),
      analytics: true,
      prefix: "logocreator",
    });
  }

  const client = new Together(options);

  if (data.userAPIKey) {
    client.apiKey = data.userAPIKey;
    (await clerkClient()).users.updateUserMetadata(user.id, {
      unsafeMetadata: {
        remaining: "BYOK",
      },
    });
  }

  if (ratelimit) {
    const identifier = user.id;
    const { success, remaining } = await ratelimit.limit(identifier);
    (await clerkClient()).users.updateUserMetadata(user.id, {
      unsafeMetadata: {
        remaining,
      },
    });

    if (!success) {
      return new Response(
        "You've used up all your credits. Enter your own Together API Key to generate more logos.",
        {
          status: 429,
          headers: { "Content-Type": "text/plain" },
        },
      );
    }
  }

  const flashyStyle =
    "Flashy, attention grabbing, bold, futuristic, and eye-catching. Use vibrant neon colors with metallic, shiny, and glossy accents.";

  const techStyle =
    "highly detailed, sharp focus, cinematic, photorealistic, Minimalist, clean, sleek, neutral color pallete with subtle accents, clean lines, shadows, and flat.";

  const modernStyle =
    "modern, forward-thinking, flat design, geometric shapes, clean lines, natural colors with subtle accents, use strategic negative space to create visual interest.";

  const playfulStyle =
    "playful, lighthearted, bright bold colors, rounded shapes, lively.";

  const abstractStyle =
    "abstract, artistic, creative, unique shapes, patterns, and textures to create a visually interesting and wild logo.";

  const minimalStyle =
    "minimal, simple, timeless, versatile, single color logo, use negative space, flat design with minimal details, Light, soft, and subtle.";

  const styleLookup: Record<string, string> = {
    Flashy: flashyStyle,
    Tech: techStyle,
    Modern: modernStyle,
    Playful: playfulStyle,
    Abstract: abstractStyle,
    Minimal: minimalStyle,
  };

  const prompt = dedent`Create a professional logo with these EXACT specifications:

  1. COLORS (MUST BE EXACT):
     - Primary Color: ${data.selectedPrimaryColor}
     - Background Color: ${data.selectedBackgroundColor}
     These hex colors are mandatory and must be used exactly as specified.

  2. STYLE:
     ${styleLookup[data.selectedStyle]}

  3. CONTENT:
     - Company Name: "${data.companyName}" (must be included in the logo)
     ${data.additionalInfo ? `- Additional Details: ${data.additionalInfo}` : ''}
  
  4. REQUIREMENTS:
     - High-quality, award-winning professional design
     - Made for both digital and print media
     - Contains only a few vector shapes
     - Clean and professional appearance
     - STRICT COLOR ADHERENCE: Use the exact hex colors specified above

  The most important requirement is to use the exact hex colors provided. Do not substitute or modify these colors in any way.`;

  try {
    const response = await client.images.create({
      prompt,
      model: "black-forest-labs/FLUX.1.1-pro",
      width: 768,
      height: 768,
      steps: 4,
      negative_prompt: "different colors, alternate colors, modified colors, wrong colors, color variation",
      // @ts-expect-error - this is not typed in the API
      response_format: "base64",
      seed: Math.floor(Math.random() * 1000000), // Add randomness to each generation
      cfg_scale: 8, // Increase cfg_scale for more prompt adherence
    });
    return Response.json(response.data[0], { status: 200 });
  } catch (error) {
    const invalidApiKey = z
      .object({
        error: z.object({
          error: z.object({ code: z.literal("invalid_api_key") }),
        }),
      })
      .safeParse(error);

    if (invalidApiKey.success) {
      return new Response("Your API key is invalid.", {
        status: 401,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const modelBlocked = z
      .object({
        error: z.object({
          error: z.object({ type: z.literal("request_blocked") }),
        }),
      })
      .safeParse(error);

    if (modelBlocked.success) {
      return new Response(
        "Your Together AI account needs a credit card on file to use this app. Please add a credit card at: https://api.together.xyz/settings/billing",
        {
          status: 403,
          headers: { "Content-Type": "text/plain" },
        },
      );
    }

    throw error;
  }
}

export const runtime = "edge";
