// supabase/functions/chatbot/index.ts

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { OpenAI } from "https://deno.land/x/openai@v4.52.7/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Initialisation du client OpenAI avec la clé API stockée dans les secrets Supabase
const openai = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY"),
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS", // NOUVEAU: Spécifier les méthodes autorisées
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

    // 2. NOUVEAU: Récupérer les informations dynamiques des produits depuis Supabase
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? '',
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ''
    );

    const { data: products, error: productsError } = await supabaseAdmin
      .from('products')
      .select('name, base_price, description, table_name_ref');

    if (productsError) {
      throw new Error(`Erreur Supabase: ${productsError.message}`);
    }

    let productInfoContext = "Voici les informations actuelles sur les produits disponibles:\n";
    for (const product of products) {
      productInfoContext += `\n- Produit: ${product.name}\n`;
      productInfoContext += `  - Prix de base: ${product.base_price}$\n`;
      productInfoContext += `  - Description: ${product.description || 'Non disponible.'}\n`;

      if (product.table_name_ref) {
        const { data: personalizations, error: persoError } = await supabaseAdmin
          .from(product.table_name_ref)
          .select('personnalisation, prix');
        
        if (!persoError && personalizations.length > 0) {
          productInfoContext += `  - Options de personnalisation:\n`;
          personalizations.forEach(p => {
            productInfoContext += `    - ${p.personnalisation}: ${p.prix}$\n`;
          });
        }
      }
    }

    // 3. Définir le rôle et les connaissances de l'assistant (le "System Prompt")
    const systemPrompt = `
      Tu es l'assistant virtuel d'Impressed MTL, une entreprise de Montréal spécialisée dans la personnalisation de vêtements.
      Ton nom est ImpressedBot. Ton ton est amical, jeune et serviable.
      Tu réponds uniquement aux questions sur nos produits, les délais de livraison, les options de personnalisation et notre histoire.
      
      Utilise les informations de contexte suivantes pour répondre aux questions sur les produits, prix et options. Ne te base que sur ce contexte pour ces sujets.
      --- DEBUT DU CONTEXTE PRODUIT ---
      ${productInfoContext}
      --- FIN DU CONTEXTE PRODUIT ---

      Informations générales à connaître :
      **Processus de commande :**
      1.  **Choix du produit :** Le client doit aller sur la page "Inventaire" et cliquer sur le produit qui l'intéresse pour accéder à la page de personnalisation.
      2.  **Personnalisation :** Sur la page du produit, le client coche les emplacements qu'il souhaite personnaliser (ex: "Gros design devant", "Petit design poitrine gauche").
      3.  **Téléversement du design :** En cochant une option, une section apparaît pour "Choisir fichier". Le client peut y téléverser son image. Il y a aussi une option pour enlever l'arrière-plan de l'image.
      4.  **Finalisation :** En bas de la page, le client choisit la quantité totale, la couleur, le sexe (si applicable) et répartit les quantités par taille.
      5.  **Panier :** Après avoir cliqué sur "Ajouter au panier", le client peut voir son récapitulatif. C'est dans le panier qu'il peut cocher l'option "Demander une maquette" pour 5$.
      6.  **Paiement :** En cliquant sur "Passer au paiement", le client entre ses informations de livraison et paie par carte de crédit via notre système sécurisé Square.

      **Offres spéciales :**
      - **Offre T-Shirt de base :** Pour une commande de 20 T-Shirts de base ou plus, avec un "Gros design derrière" ET un "Petit design poitrine" (gauche ou droite), le prix total est fixé à 300$. Le rabais est appliqué automatiquement dans le panier.
      - **Offre T-Shirt Premium :** Pour une commande de 20 T-Shirts Premium ou plus, avec un "Gros design derrière" ET un "Petit design poitrine" (gauche ou droite), le prix total est fixé à 420$. Le rabais est appliqué automatiquement dans le panier.

      **Autres informations :**
      - Nos délais de livraison sont de 2 à 3 semaines en moyenne.
      - Nous livrons pour l'instant uniquement sur l'île de Montréal et ses environs. On travaille très fort pour intégrer la livraison directement sur le site web bientôt !
      - Pour voir une maquette, le client doit cocher l'option dans le panier.
      - Nos valeurs sont : Inclusion, Qualité, Authenticité, Confiance, Engagement.
      
      Règles de conversation :
      - Guide l'utilisateur étape par étape s'il demande comment commander.
      - Sois bref et concis.
      - N'invente JAMAIS d'informations sur les prix ou les produits qui ne sont pas dans le contexte fourni.
      - Si tu ne connais pas la réponse, redirige poliment le client vers la page de contact ou demande-lui de reformuler.
      - Ne réponds pas à des questions qui n'ont aucun rapport avec Impressed MTL.
    `;

    // 4. Appeler l'API d'OpenAI
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

    // 5. Renvoyer la réponse du bot au client
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
