// supabase/functions/calculate-shipping/index.ts

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // --- 1. Récupérer les données envoyées par le client ---
    console.log("Step 1: Parsing request body...");
    const { cart, shippingAddress } = await req.json();

    if (!cart || cart.length === 0 || !shippingAddress) {
      throw new Error("Les détails du panier ou l'adresse de livraison sont manquants.");
    }

    // --- 2. Vérifier les secrets et initialiser les clients ---
    console.log("Step 2: Checking secrets and initializing clients...");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const easyPostApiKey = Deno.env.get("EASYPOST_API_KEY");

    if (!supabaseUrl || !supabaseServiceKey || !easyPostApiKey) {
      const missingKeys: string[] = [];
      if (!supabaseUrl) missingKeys.push("SUPABASE_URL");
      if (!supabaseServiceKey) missingKeys.push("SUPABASE_SERVICE_ROLE_KEY");
      if (!easyPostApiKey) missingKeys.push("EASYPOST_API_KEY");
      throw new Error(`Configuration serveur incomplète. Clés secrètes manquantes: ${missingKeys.join(', ')}`);
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // --- 3. Calculer le poids total du colis ---
    console.log("Step 3: Calculating total weight...");
    // CORRECTION: Extraire uniquement les nombres des ID de produits (ex: "v2_1" -> "1")
    const productIds = cart
      .map((item: { product_id: string }) => item.product_id.startsWith('v2_') ? item.product_id.replace('v2_', '') : null)
      .filter((id: string | null): id is string => id !== null);
    
    let productsWeightMap = new Map<number, number>();

    // CORRECTION: Ne faire la requête que si on a des produits V2
    if (productIds.length > 0) {
      const { data: productsData, error: productsError } = await supabaseAdmin
        .from('products')
        .select('id, weight_grams')
        .in('id', productIds);

      if (productsError) throw productsError;

      // Créer la map des poids si des données sont retournées
      if (productsData) {
        productsWeightMap = new Map(productsData.map(p => [Number(p.id), p.weight_grams]));
      }
    }
    
    let totalWeightGrams = 0;
    cart.forEach((item: { product_id: string; quantity: number }) => {
      // CORRECTION: Gérer les produits V1 et V2
      if (item.product_id.startsWith('v2_')) {
        const productIdNumber = parseInt(item.product_id.replace('v2_', ''), 10);
        const weight = productsWeightMap.get(productIdNumber) || 250; // Poids par défaut pour un produit V2 non trouvé
        totalWeightGrams += weight * item.quantity;
      } else {
        // Pour les anciens produits (V1), on utilise un poids par défaut générique.
        const defaultWeightForV1 = 250; // Estimation raisonnable pour un vêtement
        totalWeightGrams += defaultWeightForV1 * item.quantity;
      }
    });

    // Convertir en onces (oz) car c'est l'unité standard pour EasyPost
    const totalWeightOunces = totalWeightGrams * 0.035274;

    console.log(`Total weight calculated: ${totalWeightGrams}g / ${totalWeightOunces}oz`);

    // --- 4. Préparer le corps de la requête pour l'API EasyPost ---
    console.log("Step 4: Preparing EasyPost API request body...");
    const requestBody = {
      shipment: {
        to_address: {
          name: shippingAddress.fullName,
          street1: shippingAddress.address,
          street2: shippingAddress.apartment,
          city: shippingAddress.city,
          state: 'QC',
          zip: shippingAddress.postalCode,
          country: 'CA',
          email: shippingAddress.email,
          phone: shippingAddress.phone
        },
        from_address: {
          company: 'Impressed MTL',
          street1: '765 Rue Bourget',
          street2: 'App 112',
          city: 'Montréal',
          state: 'QC',
          zip: 'H4C 0A5',
          country: 'CA',
          phone: '514-966-5837'
        },
        parcel: {
          length: 12, // en pouces (inches)
          width: 10,  // en pouces (inches)
          height: 5,  // en pouces (inches)
          weight: totalWeightOunces, // en onces (oz)
        }
      }
    };

    // --- 5. Appeler directement l'API EasyPost avec fetch ---
    console.log("Step 5: Calling EasyPost API via fetch...");
    // CORRECTION DÉFINITIVE: EasyPost utilise l'authentification "Basic", pas "Bearer". 
    // La clé API est utilisée comme nom d'utilisateur, avec un mot de passe vide.
    const basicAuth = btoa(`${easyPostApiKey}:`); // btoa encode en Base64

    const easyPostResponse = await fetch("https://api.easypost.com/v1/shipments", {
      method: 'POST',
      headers: {
        // L'authentification Basic se fait en encodant "username:password" en Base64.
        // Pour EasyPost, c'est "VOTRE_API_KEY:".
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    const shipment = await easyPostResponse.json();
    if (!easyPostResponse.ok) {
      throw new Error(`Erreur de l'API EasyPost: ${JSON.stringify(shipment.error)}`);
    }

    console.log("Shipment created successfully. Formatting rates...");

    // --- 6. Formatter et renvoyer les tarifs au client ---
    // Définir un type pour les objets "rate" d'EasyPost pour éviter 'any'
    interface EasyPostRate {
      id: string;
      carrier: string;
      service: string;
      rate: string;
      currency: string;
      delivery_days: number | null;
    }

    const rates = shipment.rates.map((rate: EasyPostRate) => ({
      id: rate.id,
      service: `${rate.carrier} ${rate.service}`,
      amount: parseFloat(rate.rate),
      currency: rate.currency,
      delivery_days: rate.delivery_days,
    }));

    console.log("Step 6: Success! Returning rates to client.");

    return new Response(JSON.stringify({ rates }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    console.error("Erreur dans la fonction calculate-shipping:", error);
    const errorMessage = error instanceof Error ? error.message : "Une erreur inconnue est survenue.";
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});