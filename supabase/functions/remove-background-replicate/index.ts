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
  // Gérer la requête "pre-flight" CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { imageUrl } = await req.json();
    if (!imageUrl) {
      throw new Error("L'URL de l'image est manquante.");
    }

    // Récupérer la clé API depuis les secrets
    const REPLICATE_API_TOKEN = Deno.env.get("REPLICATE_API_TOKEN");
    if (!REPLICATE_API_TOKEN) {
      throw new Error("La clé API pour Replicate n'est pas configurée côté serveur.");
    }

    // Étape 1: Lancer la prédiction sur Replicate
    const startResponse = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // La version du modèle 851-labs/background-remover
        version: "9542d1a503e71c4a8954543f0a33a3c97c324335843b96443a8537c1843c1399",
        input: { image: imageUrl },
      }),
    });

    const prediction = await startResponse.json();
    if (startResponse.status !== 201) {
      throw new Error(`Erreur de l'API Replicate: ${prediction.detail}`);
    }

    // Étape 2: Attendre le résultat de la prédiction (c'est ce qui peut prendre du temps)
    let finalPrediction;
    const getUrl = prediction.urls.get;

    while (true) {
      const getResponse = await fetch(getUrl, {
        headers: {
          "Authorization": `Token ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      });
      finalPrediction = await getResponse.json();

      if (finalPrediction.status === "succeeded" || finalPrediction.status === "failed") {
        break; // Sortir de la boucle si c'est terminé ou si ça a échoué
      }

      // Attendre 1 seconde avant de vérifier à nouveau
      await sleep(1000);
    }

    if (finalPrediction.status === "failed") {
      throw new Error(`La prédiction Replicate a échoué: ${finalPrediction.error}`);
    }

    // Étape 3: Renvoyer l'URL de l'image sans arrière-plan
    const newImageUrl = finalPrediction.output;

    return new Response(JSON.stringify({ newImageUrl }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (e) {
    // Log l'erreur complète pour le débogage côté serveur
    console.error(e);
    // S'assurer que nous avons un message d'erreur à renvoyer
    const errorMessage = e instanceof Error ? e.message : "Une erreur inconnue est survenue.";
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
