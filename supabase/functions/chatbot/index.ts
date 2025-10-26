// supabase/functions/chatbot/index.ts

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { OpenAI } from "https://deno.land/x/openai@v4.52.7/mod.ts";

// Initialisation du client OpenAI avec la clé API stockée dans les secrets Supabase
const openai = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY"),
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Gérer la requête CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Extraire l'historique de la conversation depuis la requête du client
    const { conversationHistory } = await req.json();

    if (!conversationHistory) {
      throw new Error("L'historique de la conversation est manquant.");
    }

    // 2. Définir le rôle et les connaissances de l'assistant (le "System Prompt")
    const systemPrompt = `
      Tu es l'assistant virtuel d'Impressed MTL, une entreprise de Montréal spécialisée dans la personnalisation de vêtements.
      Ton nom est ImpressedBot. Ton ton est amical, jeune et serviable.
      Tu réponds uniquement aux questions sur nos produits, les délais de livraison, les options de personnalisation et notre histoire.
      
      Informations clés à connaître :
      - Nos délais de livraison sont de 2 à 3 semaines en moyenne.
      - Nous livrons pour l'instant uniquement sur l'île de Montréal et ses environs.
      - Pour voir une maquette, le client doit cocher l'option dans le panier.
      - Nous avons des offres spéciales pour les commandes en gros (20 articles et plus).
      - Nos valeurs sont : Inclusion, Qualité, Authenticité, Confiance, Engagement.
      
      Règles importantes :
      - Sois bref et concis.
      - N'invente JAMAIS d'informations.
      - Si tu ne connais pas la réponse, redirige poliment le client vers la page de contact ou demande-lui de reformuler.
      - Ne réponds pas à des questions qui n'ont aucun rapport avec Impressed MTL.
    `;

    // 3. Appeler l'API d'OpenAI
    const chatCompletion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // Modèle rapide et économique, parfait pour commencer
      messages: [
        { role: "system", content: systemPrompt },
        ...conversationHistory, // Intégrer l'historique de la conversation
      ],
      temperature: 0.5, // Un peu de créativité, mais pas trop
      max_tokens: 150, // Limite la longueur de la réponse pour être concis
    });

    const botResponse = chatCompletion.choices[0].message.content;

    // 4. Renvoyer la réponse du bot au client
    return new Response(JSON.stringify({ reply: botResponse }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    console.error("Erreur dans la fonction chatbot:", error);    
    const errorMessage = error instanceof Error ? error.message : "Une erreur inconnue est survenue.";
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
