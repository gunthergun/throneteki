const Phase = require('./phase.js');
const SimpleStep = require('./simplestep.js');
const DiscardToReservePrompt = require('./taxation/discardtoreserveprompt.js');
const ActionWindow = require('./actionwindow.js');

class TaxationPhase extends Phase {
    constructor(game) {
        super(game, 'taxation');
        this.initialise([
            new SimpleStep(game, () => this.returnGold()),
            new DiscardToReservePrompt(game),
            new SimpleStep(game, () => this.returnTitleCards()),
            new ActionWindow(game, 'After reserve check', 'taxation'),
            new SimpleStep(game, () => this.roundEnded())
        ]);
    }

    returnGold() {
        for(const player of this.game.getPlayersInFirstPlayerOrder()) {
            if(!player.doesNotReturnUnspentGold) {
                this.game.returnGoldToTreasury({ player: player, amount: player.gold });
            }
        }
    }

    returnTitleCards() {
        if(!this.game.isMelee) {
            return;
        }

        for(const player of this.game.getPlayers()) {
            this.game.titlePool.returnToPool(player, player.title);
        }
    }

    roundEnded() {
        this.game.raiseEvent('onRoundEnded');

        let players = this.game.getPlayers();
        let playerStr = players.map(player => `${player.name}: ${player.getTotalPower()}`).join(', ');

        this.game.round++;

        this.game.addAlert('endofround', 'Round {0} has ended {1} totals: {2}', this.game.round, 'power', playerStr);
    }
}

module.exports = TaxationPhase;
