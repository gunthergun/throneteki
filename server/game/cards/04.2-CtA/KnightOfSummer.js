const DrawCard = require('../../drawcard.js');

class KnightOfSummer extends DrawCard {
    setupCardAbilities(ability) {
        this.persistentEffect({
            condition: () => this.moreSummerThanWinterPlots(),
            match: this,
            effect: [
                ability.effects.addKeyword('Renown'),
                ability.effects.modifyStrength(2)
            ]
        });
    }

    moreSummerThanWinterPlots() {
        var summerPlots = 0;
        var winterPlots = 0;
        for(const player of this.game.getPlayers()) {
            if(player.activePlot && player.activePlot.hasTrait('winter')) {
                winterPlots++;
            }
            if(player.activePlot && player.activePlot.hasTrait('summer')) {
                summerPlots++;
            }
        }

        if(summerPlots > winterPlots) {
            return true;
        }
        return false;
    }
}
KnightOfSummer.code = '04023';

module.exports = KnightOfSummer;
