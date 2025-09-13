// supabase/functions/remove-background-replicate/index.ts

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// En-têtes pour la gestion des requêtes cross-origine (CORS)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Petite fonction pour faire une pause
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

serve(async (req) => {
  // Gérer la requête "pre-flight" CORS (importante pour les appels depuis le navigateur)
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    console.log("Function invoked. Parsing request body...");
    const { imageUrl } = await req.json();
    if (!imageUrl) {
      throw new Error("L'URL de l'image est manquante.");
    }
    console.log(`Received image URL: ${imageUrl}`);

    // Récupérer la clé API depuis les secrets de la fonction Supabase
    const REPLICATE_API_TOKEN = Deno.env.get("REPLICATE_API_TOKEN");
    if (!REPLICATE_API_TOKEN) {
      throw new Error("La clé API pour Replicate n'est pas configurée côté serveur.");
    }
    console.log("Replicate API token found.");

    // Étape 1: Lancer la prédiction sur Replicate
    console.log("Sending prediction request to Replicate...");
    const startResponse = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // La version du nouveau modèle recommandé par Replicate: replicate/replicate-background-remover
        version: "fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003",
        input: { image: imageUrl },
      }),
    });

    const prediction = await startResponse.json();
    if (startResponse.status !== 201) {
      console.error("Replicate API error response:", prediction);
      throw new Error(`Erreur de l'API Replicate: ${prediction.detail}`);
    }
    console.log(`Prediction started with ID: ${prediction.id}`);

    // Étape 2: Interroger Replicate jusqu'à ce que le résultat soit prêt (polling)
    let finalPrediction;
    const getUrl = prediction.urls.get;
    let attempts = 0;
    const maxAttempts = 60; // Timeout after 60 seconds

    while (attempts < maxAttempts) {
      console.log(`Polling for result... Attempt ${attempts + 1}`);
      const getResponse = await fetch(getUrl, {
        headers: {
          "Authorization": `Token ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      });
      finalPrediction = await getResponse.json();
      console.log(`Current prediction status: ${finalPrediction.status}`);

      if (finalPrediction.status === "succeeded" || finalPrediction.status === "failed") {
        break; // Sortir de la boucle si c'est terminé ou si ça a échoué
      }

      // Attendre 1 seconde avant de vérifier à nouveau pour ne pas surcharger l'API
      await sleep(1000);
      attempts++;
    }

    if (attempts === maxAttempts) {
        throw new Error("La prédiction Replicate a dépassé le temps limite.");
    }

    if (finalPrediction.status === "failed") {
      console.error("Replicate prediction failed:", finalPrediction.error);
      throw new Error(`La prédiction Replicate a échoué: ${finalPrediction.error}`);
    }

    // Étape 3: Renvoyer l'URL de l'image sans arrière-plan
    const newImageUrl = finalPrediction.output;
    console.log(`Success! Returning new image URL: ${newImageUrl}`);

    return new Response(JSON.stringify({ newImageUrl }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (e) {
    // Log l'erreur complète pour le débogage côté serveur
    console.error("An error occurred in the Edge Function:", e);
    // S'assurer que nous avons un message d'erreur à renvoyer
    const errorMessage = e instanceof Error ? e.message : "Une erreur inconnue est survenue.";
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
