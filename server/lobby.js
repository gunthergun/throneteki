const socketio = require('socket.io');
const Socket = require('./socket.js');
const jwt = require('jsonwebtoken');
const _ = require('underscore');
const moment = require('moment');

const logger = require('./log.js');
const version = moment(require('../version.js'));
const PendingGame = require('./pendinggame.js');
const GameRouter = require('./gamerouter.js');
const MessageService = require('./services/MessageService.js');
const DeckService = require('./services/DeckService.js');
const CardService = require('./services/CardService.js');
const UserService = require('./services/UserService.js');
const validateDeck = require('../client/deck-validator.js'); // XXX Move this to a common location

class Lobby {
    constructor(server, options = {}) {
        this.socketsById = {};
        this.usersByUsername = {};
        this.gamesById = {};
        this.config = options.config;
        this.messageService = options.messageService || new MessageService(options.db);
        this.deckService = options.deckService || new DeckService(options.db);
        this.cardService = options.cardService || new CardService(options.db);
        this.userService = options.userService || new UserService(options.db);
        this.router = options.router || new GameRouter(this.config);

        this.router.on('onGameClosed', this.onGameClosed.bind(this));
        this.router.on('onPlayerLeft', this.onPlayerLeft.bind(this));
        this.router.on('onWorkerTimedOut', this.onWorkerTimedOut.bind(this));
        this.router.on('onNodeReconnected', this.onNodeReconnected.bind(this));
        this.router.on('onWorkerStarted', this.onWorkerStarted.bind(this));

        this.io = options.io || socketio(server, { perMessageDeflate: false });
        this.io.set('heartbeat timeout', 30000);
        this.io.use(this.handshake.bind(this));
        this.io.on('connection', this.onConnection.bind(this));

        this.lastUserBroadcast = moment();

        this.loadCardData();

        setInterval(() => this.clearStalePendingGames(), 60 * 1000);
    }

    async loadCardData() {
        this.titleCardData = await this.cardService.getTitleCards();
        this.shortCardData = await this.cardService.getAllCards({ shortForm: true });
    }

    // External methods
    getStatus() {
        var nodeStatus = this.router.getNodeStatus();

        return nodeStatus;
    }

    disableNode(nodeName) {
        return this.router.disableNode(nodeName);
    }

    enableNode(nodeName) {
        return this.router.enableNode(nodeName);
    }

    debugDump() {
        var games = Object.values(this.gamesById).map(game => {
            var players = Object.values(game.playersByName).map(player => {
                return {
                    name: player.name,
                    left: player.left,
                    disconnected: player.disconnected,
                    id: player.id
                };
            });

            var spectators = game.spectatorsByName.map(spectator => {
                return {
                    name: spectator.name,
                    id: spectator.id
                };
            });

            return {
                name: game.name,
                players: players,
                spectators: spectators,
                id: game.id,
                started: game.started,
                node: game.node ? game.node.identity : 'None',
                startedAt: game.createdAt
            };
        });

        var nodes = this.router.getNodeStatus();

        return {
            games: games,
            nodes: nodes,
            socketCount: this.socketsById.length,
            userCount: this.usersByUsername.length
        };
    }

    // Helpers
    findGameForUser(user) {
        return Object.values(this.gamesById).find(game => {
            if(game.spectatorsByName[user]) {
                return true;
            }

            var player = game.playersByName[user];

            if(!player || player.left) {
                return false;
            }

            return true;
        });
    }

    getUserList() {
        let userList = Object.values(this.usersByUsername).map(user => {
            return user.getShortSummary();
        });

        userList = _.sortBy(userList, user => {
            return user.name.toLowerCase();
        });

        return userList;
    }

    handshake(ioSocket, next) {
        var versionInfo = undefined;

        if(ioSocket.handshake.query.token && ioSocket.handshake.query.token !== 'undefined') {
            jwt.verify(ioSocket.handshake.query.token, this.config.secret, (err, user) => {
                if(err) {
                    ioSocket.emit('authfailed');
                    return;
                }

                this.userService.getUserById(user._id).then(dbUser => {
                    var socket = this.socketsById[ioSocket.id];
                    if(!socket) {
                        logger.error('Tried to authenticate socket but could not find it', dbUser.username);
                        return;
                    }

                    ioSocket.request.user = dbUser.getWireSafeDetails();
                    socket.user = dbUser;

                    this.doPostAuth(socket);
                }).catch(err => {
                    logger.error(err);
                });
            });
        }

        if(ioSocket.handshake.query.version) {
            versionInfo = moment(ioSocket.handshake.query.version);
        }

        if(!versionInfo || versionInfo < version) {
            ioSocket.emit('banner', 'Your client version is out of date, please refresh or clear your cache to get the latest version');
        }

        next();
    }

    // Actions
    filterGameListWithBlockList(user) {
        if(!user) {
            return this.gamesById;
        }

        return Object.values(this.gamesById).filter(game => {
            let userBlockedByOwner = game.isUserBlocked(user);
            let userHasBlockedPlayer = _.any(game.players, player => _.contains(user.blockList, player.name.toLowerCase()));
            return !userBlockedByOwner && !userHasBlockedPlayer;
        });
    }

    mapGamesToGameSummaries(games) {
        return _.chain(games)
            .map(game => game.getSummary())
            .sortBy('createdAt')
            .sortBy('started')
            .reverse()
            .value();
    }

    sendUserListFilteredWithBlockList(socket, userList) {
        let filteredUsers = userList;

        if(socket.user) {
            filteredUsers = _.reject(userList, user => {
                return _.contains(socket.user.blockList, user.name.toLowerCase());
            });
        }

        socket.send('users', filteredUsers);
    }

    broadcastGameList(socket) {
        let sockets = socket ? [socket] : Object.values(this.socketsById);
        for(const socket of sockets) {
            let filteredGames = this.filterGameListWithBlockList(socket.user);
            let gameSummaries = this.mapGamesToGameSummaries(filteredGames);
            socket.send('games', gameSummaries);
        }
    }

    broadcastUserList() {
        var now = moment();

        if((now - this.lastUserBroadcast) / 1000 < 60) {
            return;
        }

        this.lastUserBroadcast = moment();

        let users = this.getUserList();

        for(const socket of this.socketsById) {
            this.sendUserListFilteredWithBlockList(socket, users);
        }
    }

    sendGameState(game) {
        if(game.started) {
            return;
        }

        for(const player of Object.values(game.getPlayersAndSpectators())) {
            if(!this.socketsById[player.id]) {
                logger.info('Wanted to send to ', player.id, ' but have no socket');
                return;
            }

            this.socketsById[player.id].send('gamestate', game.getSummary(player.name));
        }
    }

    clearGamesForNode(nodeName) {
        for(const game of this.gamesById) {
            if(game.node && game.node.identity === nodeName) {
                delete this.gamesById[game.id];
            }
        }

        this.broadcastGameList();
    }

    clearStalePendingGames() {
        const timeout = 15 * 60 * 1000;
        let staleGames = Object.values(this.gamesById).filter(game => !game.started && Date.now() - game.createdAt > timeout);
        for(let game of staleGames) {
            logger.info('closed pending game', game.id, 'due to inactivity');
            delete this.gamesById[game.id];
        }

        if(staleGames.length > 0) {
            this.broadcastGameList();
        }
    }

    sendFilteredMessages(socket) {
        this.messageService.getLastMessages().then(messages => {
            let messagesToSend = this.filterMessages(messages, socket);
            socket.send('lobbymessages', messagesToSend.reverse());
        });
    }

    filterMessages(messages, socket) {
        if(!socket.user) {
            return messages;
        }

        return messages.filter(message => {
            return !_.contains(socket.user.blockList, message.user.username.toLowerCase());
        });
    }

    // Events
    onConnection(ioSocket) {
        var socket = new Socket(ioSocket, { config: this.config });

        socket.registerEvent('lobbychat', this.onLobbyChat.bind(this));
        socket.registerEvent('newgame', this.onNewGame.bind(this));
        socket.registerEvent('joingame', this.onJoinGame.bind(this));
        socket.registerEvent('leavegame', this.onLeaveGame.bind(this));
        socket.registerEvent('watchgame', this.onWatchGame.bind(this));
        socket.registerEvent('startgame', this.onStartGame.bind(this));
        socket.registerEvent('chat', this.onPendingGameChat.bind(this));
        socket.registerEvent('selectdeck', this.onSelectDeck.bind(this));
        socket.registerEvent('connectfailed', this.onConnectFailed.bind(this));
        socket.registerEvent('removegame', this.onRemoveGame.bind(this));
        socket.registerEvent('clearsessions', this.onClearSessions.bind(this));

        socket.on('authenticate', this.onAuthenticated.bind(this));
        socket.on('disconnect', this.onSocketDisconnected.bind(this));

        this.socketsById[ioSocket.id] = socket;

        if(socket.user) {
            this.usersByUsername[socket.user.username] = socket.user;

            this.broadcastUserList();
        }

        // Force user list send for the newly connected socket, bypassing the throttle
        this.sendUserListFilteredWithBlockList(socket, this.getUserList());
        this.sendFilteredMessages(socket);
        this.broadcastGameList(socket);

        if(!socket.user) {
            return;
        }

        var game = this.findGameForUser(socket.user.username);
        if(game && game.started) {
            this.sendHandoff(socket, game.node, game.id);
        }
    }

    doPostAuth(socket) {
        let user = socket.user;

        if(!user) {
            return;
        }

        this.broadcastUserList();
        this.sendFilteredMessages(socket);
        // Force user list send for the newly autnenticated socket, bypassing the throttle
        this.sendUserListFilteredWithBlockList(socket, this.getUserList());

        var game = this.findGameForUser(user.username);
        if(game && game.started) {
            this.sendHandoff(socket, game.node, game.id);
        }
    }

    onAuthenticated(socket, user) {
        this.userService.getUserById(user._id).then(dbUser => {
            this.usersByUsername[dbUser.username] = dbUser;
            socket.user = dbUser;

            this.doPostAuth(socket);
        }).catch(err => {
            logger.error(err);
        });
    }

    onSocketDisconnected(socket, reason) {
        if(!socket) {
            return;
        }

        delete this.socketsById[socket.id];

        if(!socket.user) {
            return;
        }

        delete this.usersByUsername[socket.user.username];

        logger.info('user \'%s\' disconnected from the lobby: %s', socket.user.username, reason);

        var game = this.findGameForUser(socket.user.username);
        if(!game) {
            return;
        }

        game.disconnect(socket.user.username);

        if(game.isEmpty()) {
            delete this.gamesById[game.id];
        } else {
            this.sendGameState(game);
        }

        this.broadcastGameList();
    }

    onNewGame(socket, gameDetails) {
        let existingGame = this.findGameForUser(socket.user.username);
        if(existingGame) {
            return;
        }

        let game = new PendingGame(socket.user.getDetails(), gameDetails);
        game.newGame(socket.id, socket.user.getDetails(), gameDetails.password, (err, message) => {
            if(err) {
                logger.info('game failed to create', err, message);

                return;
            }

            socket.joinChannel(game.id);
            this.sendGameState(game);

            this.gamesById[game.id] = game;
            this.broadcastGameList();
        });
    }

    onJoinGame(socket, gameId, password) {
        var existingGame = this.findGameForUser(socket.user.username);
        if(existingGame) {
            return;
        }

        var game = this.gamesById[gameId];
        if(!game) {
            return;
        }

        game.join(socket.id, socket.user.getDetails(), password, (err, message) => {
            if(err) {
                socket.send('passworderror', message);

                return;
            }

            socket.joinChannel(game.id);

            this.sendGameState(game);

            this.broadcastGameList();
        });
    }

    onStartGame(socket, gameId) {
        var game = this.gamesById[gameId];

        if(!game || game.started) {
            return;
        }

        if(_.any(game.getPlayers(), function(player) {
            return !player.deck;
        })) {
            return;
        }

        if(!game.isOwner(socket.user.username)) {
            return;
        }

        var gameNode = this.router.startGame(game);
        if(!gameNode) {
            return;
        }

        game.node = gameNode;
        game.started = true;

        this.broadcastGameList();

        for(const player of game.getPlayersAndSpectators()) {
            let socket = this.socketsById[player.id];

            if(!socket || !socket.user) {
                logger.error(`Wanted to handoff to ${player.name}, but couldn't find a socket`);
                return;
            }

            this.sendHandoff(socket, gameNode, game.id);
        }
    }

    sendHandoff(socket, gameNode, gameId) {
        let authToken = jwt.sign(socket.user.getWireSafeDetails(), this.config.secret, { expiresIn: '5m' });

        socket.send('handoff', {
            address: gameNode.address,
            port: gameNode.port,
            protocol: gameNode.protocol,
            name: gameNode.identity,
            authToken: authToken,
            gameId: gameId
        });
    }

    onWatchGame(socket, gameId, password) {
        var existingGame = this.findGameForUser(socket.user.username);
        if(existingGame) {
            return;
        }

        var game = this.gamesById[gameId];
        if(!game) {
            return;
        }

        game.watch(socket.id, socket.user.getDetails(), password, (err, message) => {
            if(err) {
                socket.send('passworderror', message);

                return;
            }

            socket.joinChannel(game.id);

            if(game.started) {
                this.router.addSpectator(game, socket.user.getDetails());
                this.sendHandoff(socket, game.node, game.id);
            } else {
                this.sendGameState(game);
            }
        });
    }

    onLeaveGame(socket) {
        var game = this.findGameForUser(socket.user.username);
        if(!game) {
            return;
        }

        game.leave(socket.user.username);
        socket.send('cleargamestate');
        socket.leaveChannel(game.id);

        if(game.isEmpty()) {
            delete this.gamesById[game.id];
        } else {
            this.sendGameState(game);
        }

        this.broadcastGameList();
    }

    onPendingGameChat(socket, message) {
        var game = this.findGameForUser(socket.user.username);
        if(!game) {
            return;
        }

        game.chat(socket.user.username, message);
        this.sendGameState(game);
    }

    onLobbyChat(socket, message) {
        var chatMessage = { user: socket.user.getShortSummary(), message: message, time: new Date() };

        for(const s of this.socketsById) {
            if(s.user && _.contains(s.user.blockList, chatMessage.user.username.toLowerCase())) {
                return;
            }

            s.send('lobbychat', chatMessage);
        }

        this.messageService.addMessage(chatMessage);
    }

    onSelectDeck(socket, gameId, deckId) {
        if(_.isObject(deckId)) {
            deckId = deckId._id;
        }

        var game = this.gamesById[gameId];
        if(!game) {
            return;
        }

        Promise.all([this.cardService.getAllCards(), this.cardService.getAllPacks(), this.deckService.getById(deckId), this.cardService.getRestrictedList()])
            .then(results => {
                let [cards, packs, deck, restrictedList] = results;

                for(const plot of deck.plotCards) {
                    plot.card = plot.card.custom ? plot.card : cards[plot.card.code];
                }

                for(const draw of deck.drawCards) {
                    draw.card = draw.card.custom ? draw.card : cards[draw.card.code];
                }

                if(deck.agenda) {
                    deck.agenda = cards[deck.agenda.code];
                }

                deck.status = validateDeck(deck, { packs: packs, restrictedList: restrictedList, includeExtendedStatus: false });

                game.selectDeck(socket.user.username, deck);

                this.sendGameState(game);
            })
            .catch(err => {
                logger.info(err);

                return;
            });
    }

    onConnectFailed(socket) {
        var game = this.findGameForUser(socket.user.username);
        if(!game) {
            return;
        }

        logger.info('user \'%s\' failed to handoff to game server', socket.user.username);
        this.router.notifyFailedConnect(game, socket.user.username);
    }

    onRemoveGame(socket, gameId) {
        if(!socket.user.permissions.canManageGames) {
            return;
        }

        var game = this.gamesById[gameId];
        if(!game) {
            return;
        }

        logger.info(socket.user.username, 'closed game', game.id, '(' + game.name + ') forcefully');

        if(!game.started) {
            delete this.gamesById[game.id];
        } else {
            this.router.closeGame(game);
        }
    }

    // router Events
    onGameClosed(gameId) {
        var game = this.gamesById[gameId];

        if(!game) {
            return;
        }

        delete this.gamesById[gameId];

        this.broadcastGameList();
    }

    onPlayerLeft(gameId, player) {
        var game = this.gamesById[gameId];

        if(!game) {
            return;
        }

        game.leave(player);

        if(game.isEmpty()) {
            delete this.gamesById[gameId];
        }

        this.broadcastGameList();
    }

    onClearSessions(socket, username) {
        this.userService.clearUserSessions(username).then(() => {
            let game = this.findGameForUser(username);

            if(game) {
                logger.info('closed game', game.id, '(' + game.name + ') forcefully due to clear session on', username);

                if(!game.started) {
                    delete this.gamesById[game.id];
                } else {
                    this.router.closeGame(game);
                }
            }

            let socket = Object.values(this.socketsById).find(socket => {
                return socket.user && socket.user.username === username;
            });

            if(socket) {
                socket.disconnect();
            }
        });
    }

    onWorkerTimedOut(nodeName) {
        this.clearGamesForNode(nodeName);
    }

    onWorkerStarted(nodeName) {
        this.router.sendCommand(nodeName, 'CARDDATA', { titleCardData: this.titleCardData, shortCardData: this.shortCardData });
    }

    onNodeReconnected(nodeName, games) {
        for(const game of games) {
            let owner = game.playersByName[game.owner];

            if(!owner) {
                logger.error('Got a game where the owner wasn\'t a player', game.owner);
                return;
            }

            let syncGame = new PendingGame(owner.user, { spectators: game.allowSpectators, name: game.name });
            syncGame.id = game.id;
            syncGame.node = this.router.workers[nodeName];
            syncGame.createdAt = game.startedAt;
            syncGame.started = game.started;
            syncGame.gameType = game.gameType;
            syncGame.password = game.password;

            for(const player of game.playersByName) {
                syncGame.playersByName[player.name] = {
                    id: player.id,
                    name: player.name,
                    emailHash: player.emailHash,
                    owner: game.owner === player.name,
                    faction: { cardData: { code: player.faction } },
                    agenda: { cardData: { code: player.agenda } },
                    user: player.user
                };
            }

            for(const player of game.spectatorsByName) {
                syncGame.spectatorsByName[player.name] = {
                    id: player.id,
                    name: player.name,
                    emailHash: player.emailHash,
                    user: player.user
                };
            }

            this.gamesById[syncGame.id] = syncGame;
        }

        for(const game of this.gamesById) {
            if(game.node && game.node.identity === nodeName && Object.values(games).find(nodeGame => {
                return nodeGame.id === game.id;
            })) {
                this.gamesById[game.id] = game;
            } else if(game.node && game.node.identity === nodeName) {
                delete this.gamesById[game.id];
            }
        }

        this.broadcastGameList();
    }
}

module.exports = Lobby;
