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
    
    let productsDetailsMap = new Map<number, { weight: number, volume: number }>();

    // CORRECTION: Ne faire la requête que si on a des produits V2
    if (productIds.length > 0) {
      const { data: productsData, error: productsError } = await supabaseAdmin
        .from('products')
        .select('id, weight_grams, length_cm, width_cm, height_cm')
        .in('id', productIds);

      if (productsError) throw productsError;

      // Créer la map des poids si des données sont retournées
      if (productsData) {
        productsDetailsMap = new Map(productsData.map(p => [
          Number(p.id), 
          { 
            weight: p.weight_grams || 250, // Poids par défaut si null
            volume: (p.length_cm || 30) * (p.width_cm || 25) * (p.height_cm || 2) // Volume en cm³, avec valeurs par défaut
          }
        ]));
      }
    }
    
    let totalWeightGrams = 0;
    let totalVolumeCm3 = 0;
    cart.forEach((item: { product_id: string; quantity: number; product_name: string }) => {
      // CORRECTION: Gérer les produits V1 et V2
      if (item.product_id.startsWith('v2_')) {
        const productIdNumber = parseInt(item.product_id.replace('v2_', ''), 10);
        const details = productsDetailsMap.get(productIdNumber) || { weight: 250, volume: 30*25*2 };
        totalWeightGrams += details.weight * item.quantity;
        totalVolumeCm3 += details.volume * item.quantity;
      } else {
        // Pour les anciens produits (V1), on utilise un poids par défaut générique.
        const isHoodie = (item.product_name || '').toLowerCase().includes('hoodie');
        const defaultWeight = isHoodie ? 500 : 250;
        const defaultVolume = isHoodie ? 35*30*8 : 30*25*2;
        totalWeightGrams += defaultWeight * item.quantity;
        totalVolumeCm3 += defaultVolume * item.quantity;
      }
    });

    // Convertir en onces (oz) car c'est l'unité standard pour EasyPost
    const totalWeightOunces = totalWeightGrams * 0.035274;

    console.log(`Total calculated: ${totalWeightGrams}g, ${totalVolumeCm3}cm³`);

    // --- NOUVEAU: Logique de sélection de la boîte ---
    const cm3ToInch3 = 0.0610237;
    const totalVolumeInch3 = totalVolumeCm3 * cm3ToInch3;

    // Trier les boîtes de la plus grande à la plus petite pour la logique de sélection
    const availableBoxes = [
      { name: 'Enveloppe Poly', length: 19, width: 14.5, height: 1, volume: 19 * 14.5 * 1, cost: 1.21 }, // Dimensions en pouces
      { name: 'Petite Boîte', length: 10, width: 8, height: 4, volume: 10 * 8 * 4, cost: 1.42 },
      { name: 'Grande Boîte', length: 18, width: 12, height: 10, volume: 18 * 12 * 10, cost: 3.27 },
    ];
    const sortedBoxes = [...availableBoxes].sort((a, b) => b.volume - a.volume); // Trier de la plus grande à la plus petite

    // --- NOUVELLE LOGIQUE POUR GÉRER PLUSIEURS COLIS ---
    const packedBoxes: typeof availableBoxes = [];
    let remainingVolume = totalVolumeInch3;

    while (remainingVolume > 0) {
      // Trouver la plus petite boîte qui peut contenir le volume restant
      let bestFit = sortedBoxes.slice().reverse().find(box => box.volume >= remainingVolume);
      
      // Si aucune boîte unique ne peut contenir le reste, on prend la plus grande disponible
      if (!bestFit) {
        bestFit = sortedBoxes[0]; 
      }
      
      packedBoxes.push(bestFit);
      remainingVolume -= bestFit.volume;
    }

    // Calculer le coût total de l'emballage
    const totalPackagingCost = packedBoxes.reduce((sum, box) => sum + box.cost, 0);
    // Pour l'API, on utilise les dimensions de la plus grande boîte du lot
    const largestBox = packedBoxes.sort((a, b) => b.volume - a.volume)[0];

    console.log(`Boxes selected for packing: ${packedBoxes.map(b => b.name).join(', ')}`);
    console.log(`Total packaging cost: ${totalPackagingCost.toFixed(2)}$`);

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
          length: largestBox.length, // en pouces (inches)
          width: largestBox.width,   // en pouces (inches)
          height: largestBox.height, // en pouces (inches)
          weight: totalWeightOunces, // en onces (oz)
        },
        options: {
          label_format: "PDF",
          label_size: "4x6"
        }
      }
    };

    // --- 5. Appeler directement l'API EasyPost avec fetch ---
    console.log("Step 5: Calling EasyPost API via fetch...");
    // CORRECTION: Utilisation de l'endpoint v2 et de l'authentification Bearer.
    const easyPostResponse = await fetch("https://api.easypost.com/v2/shipments", {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${easyPostApiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
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

    // NOUVEAU: Définir un type pour nos tarifs formatés
    interface FormattedRate {
      id: string;
      service: string;
      amount: number;
      currency: string;
      delivery_days: number | null;
    }

    const rates: FormattedRate[] = shipment.rates.map((rate: EasyPostRate) => ({
      id: rate.id,
      service: `${rate.carrier} ${rate.service}`,
      amount: parseFloat(rate.rate),
      currency: rate.currency,
      delivery_days: rate.delivery_days,
    }));

    console.log("Step 6: Rates fetched in USD. Converting to CAD...");

    // --- NOUVEAU: Étape 7. Conversion des tarifs de USD à CAD ---
    let exchangeRate = 1.37; // Taux par défaut au cas où l'API échoue
    try {
      const exchangeResponse = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=CAD");
      if (exchangeResponse.ok) {
        const data = await exchangeResponse.json();
        exchangeRate = data.rates.CAD;
        console.log(`Current USD to CAD exchange rate: ${exchangeRate}`);
      }
    } catch (e) {
      console.error("Could not fetch exchange rate, using default.", e);
    }

    const convertedRates = rates.map((rate: FormattedRate) => ({
      ...rate,
      amount: parseFloat(((rate.amount * exchangeRate) + totalPackagingCost + 0.50).toFixed(2)),
      currency: 'CAD',
    }));

    console.log("Step 7: Success! Returning converted rates to client.");

    return new Response(JSON.stringify({ shipmentId: shipment.id, rates: convertedRates }), {
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