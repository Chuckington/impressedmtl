// assets/js/chatbot.js

document.addEventListener('DOMContentLoaded', () => {
    // CORRECTION: Initialiser le client Supabase ici, pour être sûr que la librairie est chargée.
    const supa = supabase.createClient(
        'https://vwvvbtcatamszncjuiso.supabase.co',
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ3dnZidGNhdGFtc3puY2p1aXNvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDI2NzM4ODksImV4cCI6MjA1ODI0OTg4OX0.Vnk3723jDNQdcl7HfVXZRtL6z0KxOLV4l872azuyEWA'
    );

    // --- 1. Créer les éléments de l'interface du chatbot ---
    const chatbotContainer = document.createElement('div');
    chatbotContainer.id = 'impressed-chatbot';

    // La bulle principale cliquable
    const chatBubble = document.createElement('div');
    chatBubble.id = 'chat-bubble';
    chatBubble.innerHTML = '🤖'; // Vous pouvez remplacer par une icône SVG ou une image

    // La bulle de bienvenue (pour index.html)
    const welcomeBubble = document.createElement('div');
    welcomeBubble.id = 'chat-welcome-bubble';
    welcomeBubble.className = 'chat-welcome-bubble';
    welcomeBubble.textContent = "Bonjour, je suis ton assistant AI Impressed! Comment puis-je t'aider aujourd'hui?";

    // La fenêtre de chat complète
    const chatWindow = document.createElement('div');
    chatWindow.id = 'chat-window';
    chatWindow.className = 'chat-window';
    chatWindow.innerHTML = `
        <div class="chat-header">
            <div class="chat-title-wrapper">
                <span>Assistant Impressed</span>
                <span class="beta-tag">BETA</span>
            </div>
            <button id="close-chat-btn">&times;</button>
        </div>
        <div class="chat-body" id="chat-body">
            <!-- Les messages de la conversation apparaîtront ici -->
        </div>
        <div class="chat-footer">
            <input type="text" id="chat-input" placeholder="Pose ta question...">
            <button id="chat-send-btn">Envoyer</button>
        </div>
    `;

    // --- 2. Assembler les éléments ---
    chatbotContainer.appendChild(welcomeBubble);
    chatbotContainer.appendChild(chatBubble);
    document.body.appendChild(chatbotContainer);
    document.body.appendChild(chatWindow);

    // --- 3. Récupérer les éléments du DOM pour la logique ---
    const chatBody = document.getElementById('chat-body');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send-btn');
    const closeChatBtn = document.getElementById('close-chat-btn');

    // --- 4. Logique d'affichage et d'interaction ---

    // Variable pour stocker l'historique de la conversation
    let conversationHistory = [];

    // Afficher la bulle de bienvenue SEULEMENT sur la page d'accueil
    if (window.location.pathname === '/index.html' || window.location.pathname === '/') {
        welcomeBubble.style.display = 'block';
    }

    // Ouvrir la fenêtre de chat
    chatBubble.addEventListener('click', () => {
        chatWindow.classList.add('is-open');
        welcomeBubble.style.display = 'none';
        // Si le chat est vide, ajoute le message de bienvenue du bot
        if (chatBody.children.length === 0) {
            const welcomeMessage = "Bonjour ! Je suis l'assistant virtuel d'Impressed. Comment puis-je t'aider ?";
            addMessageToChat(welcomeMessage, 'bot');
            conversationHistory.push({ role: 'assistant', content: welcomeMessage });
        }
    });

    // Fermer la fenêtre de chat
    closeChatBtn.addEventListener('click', () => {
        chatWindow.classList.remove('is-open');
    });

    // Fonction pour ajouter un indicateur "..."
    const addTypingIndicator = () => {
        const typingElement = document.createElement('div');
        typingElement.id = 'typing-indicator';
        typingElement.className = 'chat-message bot-message typing-indicator';
        typingElement.innerHTML = '<span></span><span></span><span></span>';
        chatBody.appendChild(typingElement);
        chatBody.scrollTop = chatBody.scrollHeight;
    };

    // Fonction pour retirer l'indicateur "..."
    const removeTypingIndicator = () => {
        const typingElement = document.getElementById('typing-indicator');
        if (typingElement) {
            typingElement.remove();
        }
    };

    // Fonction pour ajouter un message (utilisateur ou bot) à la fenêtre de chat
    const addMessageToChat = (text, sender) => {
        const messageElement = document.createElement('div');
        messageElement.innerText = text; // Utiliser innerText pour une meilleure sécurité
        messageElement.className = `chat-message ${sender}-message`;
        chatBody.appendChild(messageElement);
        chatBody.scrollTop = chatBody.scrollHeight;
    };

    const handleSendMessage = async () => {
        const userMessage = chatInput.value.trim();
        if (userMessage && !chatInput.disabled) {
            // 1. Afficher le message de l'utilisateur et l'ajouter à l'historique
            addMessageToChat(userMessage, 'user');
            conversationHistory.push({ role: 'user', content: userMessage });

            // 2. Vider le champ de saisie et désactiver les contrôles
            chatInput.value = '';
            chatInput.disabled = true;
            sendBtn.disabled = true;

            // 3. Afficher l'indicateur de frappe
            addTypingIndicator();

            try {
                // 4. Appeler la Supabase Edge Function
                const { data, error } = await supa.functions.invoke('chatbot', {
                    body: { conversationHistory },
                });

                if (error) {
                    throw error;
                }

                // 5. Afficher la réponse du bot et l'ajouter à l'historique
                const botReply = data.reply;
                addMessageToChat(botReply, 'bot');
                conversationHistory.push({ role: 'assistant', content: botReply });

            } catch (error) {
                console.error("Erreur lors de l'appel à la fonction chatbot:", error);
                addMessageToChat("Désolé, une erreur est survenue. Veuillez réessayer plus tard.", 'bot');
            } finally {
                // 6. Retirer l'indicateur et réactiver les contrôles
                removeTypingIndicator();
                chatInput.disabled = false;
                sendBtn.disabled = false;
                chatInput.focus();
            }
        }
    };

    sendBtn.addEventListener('click', handleSendMessage);
    chatInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter' && !chatInput.disabled) {
            handleSendMessage();
        }
    });
});
