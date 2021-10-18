import { OrderedSet } from 'Molstar/mol-data/int';
import { AfConfidence, AfConfidenceProvider } from './prop';
import { AfConfidenceColorThemeProvider } from './color';
import { Loci } from 'Molstar/mol-model/loci';
import { StructureElement } from 'Molstar/mol-model/structure';
import { ParamDefinition as PD } from 'Molstar/mol-util/param-definition';
import { PluginBehavior } from 'Molstar/mol-plugin/behavior/behavior';

export const AfConfidenceScore = PluginBehavior.create<{ autoAttach: boolean, showTooltip: boolean }>({
    name: 'af-confidence-prop',
    category: 'custom-props',
    display: {
        name: 'AlphaFold Confidence Score',
        description: 'AlphaFold Confidence Score.'
    },
    ctor: class extends PluginBehavior.Handler<{ autoAttach: boolean, showTooltip: boolean }> {

        private provider = AfConfidenceProvider

        private labelAfConfScore = {
            label: (loci: Loci): string | undefined => {
                if (!this.params.showTooltip) return void 0;

                switch (loci.kind) {
                    case 'element-loci':
                        if (loci.elements.length === 0) return void 0;
                        const e = loci.elements[0];
                        const u = e.unit;
                        if (!u.model.customProperties.hasReference(AfConfidenceProvider.descriptor)) return void 0;

                        const se = StructureElement.Location.create(loci.structure, u, u.elements[OrderedSet.getAt(e.indices, 0)]);
                        const confidenceScore = AfConfidence.getConfidenceScore(se);
                        //VIP hover text
                        return confidenceScore ? `Confidence score: ${confidenceScore[0]} <small>( ${confidenceScore[1]} )</small>
                        <br/>Accessibility: ${confidenceScore[2]} <small>( ${confidenceScore[3]} )</small>
                        <br/>PTM: ${confidenceScore[4]}`
                        : `No confidence score`;

                    default: return void 0;
                }
            }
        }

        register(): void {
            this.ctx.customModelProperties.register(this.provider, this.params.autoAttach);
            this.ctx.managers.lociLabels.addProvider(this.labelAfConfScore);

            this.ctx.representation.structure.themes.colorThemeRegistry.add(AfConfidenceColorThemeProvider);
        }

        update(p: { autoAttach: boolean, showTooltip: boolean }) {
            let updated = this.params.autoAttach !== p.autoAttach;
            this.params.autoAttach = p.autoAttach;
            this.params.showTooltip = p.showTooltip;
            this.ctx.customModelProperties.setDefaultAutoAttach(this.provider.descriptor.name, this.params.autoAttach);
            return updated;
        }

        unregister() {
            this.ctx.customModelProperties.unregister(AfConfidenceProvider.descriptor.name);
            this.ctx.managers.lociLabels.removeProvider(this.labelAfConfScore);
            this.ctx.representation.structure.themes.colorThemeRegistry.remove(AfConfidenceColorThemeProvider);
        }
    },
    params: () => ({
        autoAttach: PD.Boolean(false),
        showTooltip: PD.Boolean(true)
    })
});