// supabase/functions/remove-background-replicate/index.ts

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

serve(async (req) => {
  console.log(`--- NEW INVOCATION: ${new Date().toISOString()} ---`);

  if (req.method === 'OPTIONS') {
    console.log("Responding to OPTIONS pre-flight request.");
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    console.log("Inside TRY block. Parsing request body...");
    const body = await req.json();
    const imageUrl = body.imageUrl;

    if (!imageUrl) {
      console.error("Validation failed: imageUrl is missing from the request body.");
      throw new Error("L'URL de l'image est manquante.");
    }
    console.log(`Received image URL: ${imageUrl}`);

    const REPLICATE_API_TOKEN = Deno.env.get("REPLICATE_API_TOKEN");
    if (!REPLICATE_API_TOKEN) {
      console.error("Security Error: REPLICATE_API_TOKEN secret not found.");
      throw new Error("La clé API pour Replicate n'est pas configurée côté serveur.");
    }
    console.log("Replicate API token found.");

    console.log("Step 1: Sending prediction request to Replicate...");
    const startResponse = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003",
        input: { image: imageUrl },
      }),
    });

    const prediction = await startResponse.json();
    console.log("Initial Replicate response received:", JSON.stringify(prediction, null, 2));

    if (startResponse.status !== 201) {
      console.error("Replicate API error on start:", prediction);
      throw new Error(`Erreur de l'API Replicate: ${prediction.detail || 'Unknown error'}`);
    }
    console.log(`Prediction started with ID: ${prediction.id}`);

    let finalPrediction;
    const getUrl = prediction?.urls?.get;
    if (!getUrl) {
        throw new Error("Replicate response did not contain a 'get' URL.");
    }

    let attempts = 0;
    const maxAttempts = 60;

    while (attempts < maxAttempts) {
      console.log(`Step 2: Polling for result... Attempt ${attempts + 1}`);
      const getResponse = await fetch(getUrl, {
        headers: { "Authorization": `Token ${REPLICATE_API_TOKEN}` },
      });
      finalPrediction = await getResponse.json();
      console.log(`  - Current prediction status: ${finalPrediction.status}`);

      if (["succeeded", "failed", "canceled"].includes(finalPrediction.status)) {
        break;
      }
      await sleep(1000);
      attempts++;
    }

    if (finalPrediction.status !== "succeeded") {
      console.error("Replicate prediction did not succeed:", finalPrediction);
      throw new Error(`La prédiction Replicate a échoué avec le statut: ${finalPrediction.status}`);
    }

    const newImageUrl = finalPrediction.output;
    if (!newImageUrl || typeof newImageUrl !== 'string') {
        console.error("Invalid output from Replicate:", finalPrediction.output);
        throw new Error("La sortie de Replicate n'est pas une URL valide.");
    }
    console.log(`Step 3: Success! Returning new image URL: ${newImageUrl}`);

    return new Response(JSON.stringify({ newImageUrl }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (e) {
    console.error("--- ERROR IN FUNCTION ---");
    console.error(e);
    const errorMessage = e instanceof Error ? e.message : "Une erreur inconnue est survenue.";
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
