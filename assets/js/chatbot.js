// assets/js/chatbot.js

document.addEventListener('DOMContentLoaded', () => {
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
            <!-- Le message de bienvenue du bot sera ajouté ici par JS -->
        </div>
        <div class="chat-footer">
            <input type="text" id="chat-input" placeholder="Pose ta question...">
            <button id="chat-send-btn">Envoyer</button>
        </div>
    `;

    // --- 2. Assembler les éléments ---
    // On ajoute d'abord la bulle de bienvenue, puis la bulle principale
    // pour qu'elle s'affiche à droite de la bulle de bienvenue grâce à flexbox.
    chatbotContainer.appendChild(welcomeBubble);
    chatbotContainer.appendChild(chatBubble);
    
    // La fenêtre de chat est ajoutée séparément au body pour une gestion plus simple du positionnement
    document.body.appendChild(chatbotContainer);
    document.body.appendChild(chatWindow);

    // --- 3. Logique d'affichage et d'interaction ---

    // Afficher la bulle de bienvenue SEULEMENT sur la page d'accueil
    if (window.location.pathname === '/index.html' || window.location.pathname === '/') {
        welcomeBubble.style.display = 'block';
    }

    const closeChatBtn = document.getElementById('close-chat-btn');

    // Ouvrir la fenêtre de chat
    chatBubble.addEventListener('click', () => {
        chatWindow.classList.add('is-open');
        // Cacher la bulle de bienvenue si elle est visible
        welcomeBubble.style.display = 'none';
        // Si le chat est vide, ajoute le message de bienvenue du bot
        if (chatBody.children.length === 0) {
            addMessageToChat("Bonjour ! Je suis l'assistant virtuel d'Impressed. Comment puis-je t'aider ?", 'bot');
        }
    });

    // Fermer la fenêtre de chat
    closeChatBtn.addEventListener('click', () => {
        chatWindow.classList.remove('is-open');
    });

    // Ici, vous ajouterez plus tard la logique pour envoyer les messages
    // à votre Supabase Edge Function et afficher les réponses.
    const sendBtn = document.getElementById('chat-send-btn');
    const chatInput = document.getElementById('chat-input');
    const chatBody = document.getElementById('chat-body');

    // Fonction pour ajouter un message (utilisateur ou bot) à la fenêtre de chat
    const addMessageToChat = (text, sender) => {
        const messageElement = document.createElement('div');
        messageElement.textContent = text;
        // Applique la bonne classe CSS en fonction de l'expéditeur
        messageElement.className = `chat-message ${sender}-message`;
        chatBody.appendChild(messageElement);
        // Fait défiler automatiquement vers le bas pour voir le dernier message
        chatBody.scrollTop = chatBody.scrollHeight;
    };

    const handleSendMessage = () => {
        const userMessage = chatInput.value.trim();
        if (userMessage) {
            // 1. Afficher le message de l'utilisateur
            addMessageToChat(userMessage, 'user');

            // 2. Vider le champ de saisie et y remettre le focus
            chatInput.value = '';
            chatInput.focus();
        }
    };

    sendBtn.addEventListener('click', handleSendMessage);
    chatInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            handleSendMessage();
        }
    });
});
