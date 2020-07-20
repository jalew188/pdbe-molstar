import { Structure, Unit, ResidueIndex, Model, Link } from 'Molstar/mol-model/structure';
import { BuiltInStructureRepresentationsName } from 'Molstar/mol-repr/structure/registry';
import { BuiltInColorThemeName } from 'Molstar/mol-theme/color';
import { AminoAcidNames } from 'Molstar/mol-model/structure/model/types';
import { PluginContext } from 'Molstar/mol-plugin/context';
import { MolScriptBuilder as MS } from 'Molstar/mol-script/language/builder';
import Expression from 'Molstar/mol-script/language/expression';
import { compile } from 'Molstar/mol-script/runtime/query/compiler';
import { StructureElement, StructureSelection, QueryContext, StructureProperties as Props } from 'Molstar/mol-model/structure';

import { Task, RuntimeContext } from 'Molstar/mol-task';
import { utf8Read } from 'Molstar/mol-io/common/utf8';
import { parseXml } from 'Molstar/mol-util/xml-parser';

export interface ModelInfo {
    hetResidues: { name: string, indices: ResidueIndex[] }[],
    assemblies: { id: string, details: string, isPreferred: boolean }[],
    modelCount: number,
    preferredAssemblyId: string | undefined,
    validationApi: boolean | undefined,
    domainMappings: any | undefined
}

export namespace ModelInfo {

    export function getStreamingMethod(s?: Structure, defaultKind: string = 'x-ray'): string {
        if (!s) return defaultKind;
    
        const model = s.models[0];
        if (model.sourceData.kind !== 'mmCIF') return defaultKind;
    
        const data = model.sourceData.data.exptl.method;
       
        for (let i = 0; i < data.rowCount; i++) {
            const v = data.value(i).toUpperCase();
            if (v.indexOf('MICROSCOPY') >= 0) return 'em';
            if (v.indexOf("SOLUTION NMR") >= 0) return 'nmr';
        }
        return 'x-ray';
    }

    async function getValidation(ctx: PluginContext, pdbId: string) {
        if(!pdbId) return void 0;
        try {
            const src = await ctx.runTask(ctx.fetch({ url: `https://www.ebi.ac.uk/pdbe/api/validation/residuewise_outlier_summary/entry/${pdbId}` })) as string;
            if(src){
                return true;
            }
            return void 0;
        } catch (e) {
            return void 0;
        }
    }

    async function getDomainMapping(ctx: PluginContext, pdbId: string) {
        if(!pdbId) return void 0;
        try {
            const src = await ctx.runTask(ctx.fetch({ url: `https://www.ebi.ac.uk/pdbe/api/mappings/${pdbId}` })) as string;
            const json = JSON.parse(src);
            const data = json && json[pdbId];
            const defaultDomains = ['Pfam', 'InterPro', 'CATH', 'SCOP'];
            let availableDomains: [string, string][] = [];
            let domainsMappingsSelect: [string, any][][] = [];
            let domainsMappings: any[] = [];
            Object.keys(data).forEach(domainName => {
                if(defaultDomains.indexOf(domainName) > -1 && Object.keys(data[domainName]).length > 0){
                    availableDomains.push([domainName, domainName]);
                    const dmIndex = availableDomains.length - 1;
                    Object.keys(data[domainName]).forEach(acc => {
                        if(!domainsMappingsSelect[dmIndex]){
                            domainsMappingsSelect[dmIndex] = [];
                            domainsMappings[dmIndex] = [];
                        }
                        const mappingStr = dmIndex+'_'+domainsMappingsSelect[dmIndex].length;
                        // const domainLabel = (domainsMappings[dmIndex].length + 1)+': '+data[domainName][acc].identifier
                        // domainsMappings[dmIndex].push([data[domainName][acc].mappings, data[domainName][acc].identifier]);
                        domainsMappingsSelect[dmIndex].push([mappingStr, data[domainName][acc].identifier]);
                        domainsMappings[dmIndex].push(data[domainName][acc].mappings);
                    });

                }

            });

            if(availableDomains.length > 0){
                const mappings = {
                    types: availableDomains,
                    mappingsSelect: domainsMappingsSelect,
                    mappings: domainsMappings
                }
            
                return mappings;
            }else {
                return void 0;
            }
        } catch (e) {
            return void 0;
        }
    }

    async function getPreferredAssembly(ctx: PluginContext, pdbId: string) {
        if(!pdbId) return void 0;

        try {
            const src = await ctx.runTask(ctx.fetch({ url: `https://www.ebi.ac.uk/pdbe/api/pdb/entry/summary/${pdbId}` })) as string;
            const json = JSON.parse(src);
            const data = json && json[pdbId];

            const assemblies = data[0] && data[0].assemblies;
            if (!assemblies || !assemblies.length) return void 0;

            for (const asm of assemblies) {
                if (asm.preferred) {
                    return asm.assembly_id;
                }
            }
            return void 0;
        } catch (e) {
            console.warn('getPreferredAssembly', e);
        }
    }

    export async function get(ctx: PluginContext, model: Model, checkPreferred: boolean, checkValidation: boolean, getMappings: boolean): Promise<ModelInfo> {
        const { _rowCount: residueCount } = model.atomicHierarchy.residues;
        const { offsets: residueOffsets } = model.atomicHierarchy.residueAtomSegments;
        const chainIndex = model.atomicHierarchy.chainAtomSegments.index;
        // const resn = SP.residue.label_comp_id, entType = SP.entity.type;

        let pdbId : string;
        let labelVal = model.label;
        let labelValLength = labelVal.length;
        let pdbPattern = /pdb.*\.ent/g;
        if (labelValLength > 4 && pdbPattern.test(labelVal)){
            labelVal = labelVal.substring(labelValLength - 8, labelValLength - 4);
        }
        pdbId = ((ctx.customState as any).initParams.moleculeId) ? (ctx.customState as any).initParams.moleculeId : labelVal.toLowerCase();

        const pref = checkPreferred
            ? getPreferredAssembly(ctx, pdbId)
            : void 0;

        const validation = checkValidation
            ? getValidation(ctx, pdbId)
            : void 0;

        const mappings = getMappings
        ? getDomainMapping(ctx, pdbId)
        : void 0;

        const hetResidues: ModelInfo['hetResidues'] = [];
        const hetMap = new Map<string, ModelInfo['hetResidues'][0]>();

        for (let rI = 0 as ResidueIndex; rI < residueCount; rI++) {
            const comp_id = model.atomicHierarchy.residues.label_comp_id.value(rI);
            if (AminoAcidNames.has(comp_id)) continue;
            const mod_parent = model.properties.modifiedResidues.parentId.get(comp_id);
            if (mod_parent && AminoAcidNames.has(mod_parent)) continue;

            const cI = chainIndex[residueOffsets[rI]];
            const eI = model.atomicHierarchy.index.getEntityFromChain(cI);
            if (model.entities.data.type.value(eI) === 'water') continue;

            let lig = hetMap.get(comp_id);
            if (!lig) {
                lig = { name: comp_id, indices: [] };
                hetResidues.push(lig);
                hetMap.set(comp_id, lig);
            }
            lig.indices.push(rI);
        }

        //models
        const molecule = ctx.state.behavior.currentObject.value.state.cells.get("molecule");
        let modelCount = 1;
        if(molecule && molecule.obj){
            if(molecule.obj.data && molecule.obj.data.length > 1) modelCount = molecule.obj.data.length;
        }

        const preferredAssemblyId = await pref;

        const validationApi = await validation;

        const domainMappings = await mappings;

        return {
            hetResidues: hetResidues,
            assemblies: model.symmetry.assemblies.map(a => ({ id: a.id, details: a.details, isPreferred: a.id === preferredAssemblyId })),
            modelCount,
            preferredAssemblyId,
            validationApi,
            domainMappings
        };
    }
}

export type SupportedFormats = 'bcif' | 'cif' | 'pdb' | 'sdf'
export interface LoadParams {
    url: string,
    format?: SupportedFormats,
    assemblyId?: string,
    representationStyle?: RepresentationStyle,
    isHetView?: boolean
}

export interface RepresentationStyle {
    sequence?: RepresentationStyle.Entry,
    hetGroups?: RepresentationStyle.Entry,
    snfg3d?: { hide?: boolean },
    water?: RepresentationStyle.Entry
}

export namespace RepresentationStyle {
    export type Entry = { hide?: boolean, kind?: BuiltInStructureRepresentationsName, coloring?: BuiltInColorThemeName }
}

export namespace InteractivityHelper {

    // for `labelFirst`, don't create right away to avoid problems with circular dependencies/imports
    let elementLocA: StructureElement.Location
    let elementLocB: StructureElement.Location

    function setElementLocation(loc: StructureElement.Location, unit: Unit, index: StructureElement.UnitIndex) {
        loc.unit = unit
        loc.element = unit.elements[index]
    }

    function getDataByLoction(location: any){
        if (Unit.isAtomic(location.unit)) {
            return getAtomicElementData(location);
        } else if (Unit.isCoarse(location.unit)) {
            return getCoarseElementData(location);
        }
    }

    function getAtomicElementData(location: any){
        return {
            entity_id: Props.chain.label_entity_id(location),
            entry_id: location.unit.model.entry,
            label_asym_id: Props.chain.label_asym_id(location),
            auth_asym_id: Props.chain.auth_asym_id(location),
            //seq_id: location.unit.model.atomicHierarchy.residues.auth_seq_id.isDefined ? Props.residue.auth_seq_id(location) : Props.residue.label_seq_id(location),
            seq_id: Props.residue.label_seq_id(location),
            auth_seq_id: location.unit.model.atomicHierarchy.residues.auth_seq_id.isDefined ? Props.residue.auth_seq_id(location) : undefined,
            ins_code: Props.residue.pdbx_PDB_ins_code(location),
            comp_id: Props.residue.label_comp_id(location),
            atom_id: Props.atom.label_atom_id(location),
            alt_id: Props.atom.label_alt_id(location),
        }
    }

    function getCoarseElementData(location: any){
        let dataObj: any = {
            asym_id: Props.coarse.asym_id(location),
            seq_id_begin: Props.coarse.seq_id_begin(location),
            seq_id_end: Props.coarse.seq_id_end(location),
        }
        if (dataObj.seq_id_begin === dataObj.seq_id_end) {
            const entityIndex = Props.coarse.entityKey(location)
            const seq = location.unit.model.sequence.byEntityKey[entityIndex]
            const comp_id = seq.sequence.compId.value(dataObj.seq_id_begin - 1) // 1-indexed
            dataObj['comp_id'] = comp_id;
        }
        return dataObj;
    }

    function getElementLociData(stats: any): any{
        // const stats: StructureElement.Stats = StructureElement.Stats.ofLoci(loci);
        const { unitCount, residueCount, elementCount } = stats;
        let location:any;
        if (elementCount === 1 && residueCount === 0 && unitCount === 0) {
            location = stats.firstElementLoc;
        } else if (elementCount === 0 && residueCount === 1 && unitCount === 0) {
            location = stats.firstResidueLoc;
        } else if (elementCount === 0 && residueCount === 0 && unitCount === 1) {
            location = stats.firstUnitLoc;
        }

        if(location) return getDataByLoction(location)
    }

    function getLinkLociData(link: Link.Location): any{
        if (!elementLocA) elementLocA = StructureElement.Location.create()
        if (!elementLocB) elementLocB = StructureElement.Location.create()
        setElementLocation(elementLocA, link.aUnit, link.aIndex)
        setElementLocation(elementLocB, link.bUnit, link.bIndex)
        const eleLoc = getDataByLoction(elementLocA);
        const endAtm = getDataByLoction(elementLocB).atom_id;
        let linkDataObj = Object.assign({},eleLoc);
        linkDataObj['start_atom_id'] = eleLoc.atom_id;
        linkDataObj['end_atom_id'] = endAtm;
        delete linkDataObj.atom_id

        return linkDataObj;
    }

    export function getDataFromLoci(loci: any): any{

        switch (loci.kind) {
            case 'element-loci':
            return getElementLociData(StructureElement.Stats.ofLoci(loci));
        case 'link-loci':
            const link = loci.links[0]
            return  link ? getLinkLociData(link) : 'Unknown'
        }

        
      
    }
}

export namespace QueryHelper {
    export function getQueryObject(params: {entity_id?: string, struct_asym_id?: string, start_residue_number?: number, end_residue_number?: number, color?: any, showSideChain?: boolean}[]) : Expression {

        let entityObjArray: any = [];

        params.forEach(param => {
                let qEntities: any = {};
                if(param.entity_id) qEntities['entity-test'] = MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_entity_id(), param.entity_id]);
                if(param.struct_asym_id) qEntities['chain-test'] = MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_asym_id(), param.struct_asym_id]);

                if(!param.start_residue_number && !param.end_residue_number){
                    //entityObjArray.push(qEntities);
                }else if(param.start_residue_number && param.end_residue_number && param.end_residue_number > param.start_residue_number){
                    qEntities['residue-test'] = MS.core.rel.inRange([MS.struct.atomProperty.macromolecular.label_seq_id(), param.start_residue_number, param.end_residue_number])
                }else{
                    qEntities['residue-test'] = MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_seq_id(), param.start_residue_number]);
                }
                entityObjArray.push(qEntities);
        });

        const atmGroupsQueries: Expression[] = [];

        entityObjArray.forEach((entityObj:any) => {
            atmGroupsQueries.push(MS.struct.generator.atomGroups(entityObj));
        });

        return MS.struct.modifier.union([
            atmGroupsQueries.length === 1
                ? atmGroupsQueries[0]
                // Need to union before merge for fast performance
                : MS.struct.combinator.merge(atmGroupsQueries.map(q => MS.struct.modifier.union([ q ])))
        ]);
    }

    export function getInteractivityLoci(params: any, contextData: any){
        const query = compile<StructureSelection>(QueryHelper.getQueryObject(params));
        const sel = query(new QueryContext(contextData));
        return StructureSelection.toLociWithSourceUnits(sel);
    }

    export function getHetLoci(queryExp: Expression, contextData: any){
        const query = compile<StructureSelection>(queryExp);
        const sel = query(new QueryContext(contextData));
        return StructureSelection.toLociWithSourceUnits(sel);
    }

    function getInteractionsQueryObject(params: {pdb_res_id: string, auth_asym_id: string, auth_ins_code_id: string, auth_seq_id: number, atoms?: string[]}[]) : Expression {

        let entityObjArray: any = [];

        params.forEach(param => {
                let qEntities: any = {
                    'chain-test': MS.core.rel.eq([MS.struct.atomProperty.macromolecular.auth_asym_id(), param.auth_asym_id]),
                    'residue-test': MS.core.rel.eq([MS.struct.atomProperty.macromolecular.auth_seq_id(), param.auth_seq_id])
                };
                if(param.atoms){
                    let atomsArr:any = [];
                    param.atoms.forEach(atom => {
                        atomsArr.push(MS.core.rel.eq([MS.ammp('label_atom_id'), atom]))
                    });
                    qEntities['atom-test'] = MS.core.logic.or(atomsArr);
                    // qEntities['atom-test'] = MS.core.set.has([MS.set(param.atoms[0]), MS.ammp('label_atom_id')])
                }
                entityObjArray.push(qEntities);
        });

        const atmGroupsQueries: Expression[] = [];

        entityObjArray.forEach((entityObj:any) => {
            atmGroupsQueries.push(MS.struct.generator.atomGroups(entityObj));
        });

        // return MS.struct.modifier.union(atmGroupsQueryArr);

        return MS.struct.modifier.union([
            atmGroupsQueries.length === 1
                ? atmGroupsQueries[0]
                // Need to union before merge for fast performance
                : MS.struct.combinator.merge(atmGroupsQueries.map(q => MS.struct.modifier.union([ q ])))
        ]);
    }

    export function interactionsNodeLoci(params: any[], contextData: any){
        const query = compile<StructureSelection>(getInteractionsQueryObject(params));
        const sel = query(new QueryContext(contextData));
        return StructureSelection.toLociWithSourceUnits(sel);
    }
}

export enum StateElements {
    Model = 'model',
    ModelProps = 'model-props',
    Assembly = 'assembly',

    VolumeStreaming = 'volume-streaming',

    Sequence = 'sequence',
    SequenceVisual = 'sequence-visual',
    Het = 'het',
    HetVisual = 'het-visual',
    Het3DSNFG = 'het-3dsnfg',
    Water = 'water',
    WaterVisual = 'water-visual',

    HetGroupFocus = 'het-group-focus',
    HetGroupFocusGroup = 'het-group-focus-group',
    LigandVisual = 'ligand-visual',
    HetSurroundingVisual = 'het-surrounding-visual',
    Carbs3DVisual = 'carb-3d-visual',
    CarbsVisual = 'carb-visual'
}

import { PluginStateTransform, PluginStateObject as SO } from 'Molstar/mol-plugin/state/objects';
import { ParamDefinition as PD } from 'Molstar/mol-util/param-definition';
import { StateTransformer } from 'Molstar/mol-state';

export { DownloadPost }
type DownloadPost = typeof DownloadPost
const DownloadPost = PluginStateTransform.BuiltIn({
    name: 'download-post',
    display: { name: 'Download Post', description: 'Download string or binary data from the specified URL using POST request' },
    from: [SO.Root],
    to: [SO.Data.String, SO.Data.Binary],
    params: {
        url: PD.Text('https://www.ebi.ac.uk/pdbe/static/entry/1cbs_updated.cif', { description: 'Resource URL. Must be the same domain or support CORS.' }),
        label: PD.Optional(PD.Text('')),
        body: PD.Optional(PD.Text('')),
        isBinary: PD.Optional(PD.Boolean(false, { description: 'If true, download data as binary (string otherwise)' }))
    }
})({
    apply({ params: p }, globalCtx: PluginContext) {
        return Task.create('Download', async ctx => {
            const data = await ajaxGet({ url: p.url, type: p.isBinary ? 'binary' : 'string', body: p.body }).runInContext(ctx);
            return p.isBinary
                ? new SO.Data.Binary(data as Uint8Array, { label: p.label ? p.label : p.url })
                : new SO.Data.String(data as string, { label: p.label ? p.label : p.url });
        });
    },
    update({ oldParams, newParams, b }) {
        if (oldParams.url !== newParams.url || oldParams.isBinary !== newParams.isBinary) return StateTransformer.UpdateResult.Recreate;
        if (oldParams.label !== newParams.label) {
            b.label = newParams.label || newParams.url;
            return StateTransformer.UpdateResult.Updated;
        }
        return StateTransformer.UpdateResult.Unchanged;
    }
});


// polyfill XMLHttpRequest in node.js
const XHR = typeof document === 'undefined' ? require('xhr2') as {
    prototype: XMLHttpRequest;
    new(): XMLHttpRequest;
    readonly DONE: number;
    readonly HEADERS_RECEIVED: number;
    readonly LOADING: number;
    readonly OPENED: number;
    readonly UNSENT: number;
} : XMLHttpRequest

// export enum DataCompressionMethod {
//     None,
//     Gzip
// }

export interface AjaxGetParams<T extends 'string' | 'binary' | 'json' | 'xml' = 'string'> {
    url: string,
    type?: T,
    title?: string,
    // compression?: DataCompressionMethod
    body?: string
}

export function readStringFromFile(file: File) {
    return <Task<string>>readFromFileInternal(file, false);
}

export function readUint8ArrayFromFile(file: File) {
    return <Task<Uint8Array>>readFromFileInternal(file, true);
}

export function readFromFile(file: File, type: 'string' | 'binary') {
    return <Task<Uint8Array | string>>readFromFileInternal(file, type === 'binary');
}

// TODO: support for no-referrer
export function ajaxGet(url: string): Task<string>
export function ajaxGet(params: AjaxGetParams<'string'>): Task<string>
export function ajaxGet(params: AjaxGetParams<'binary'>): Task<Uint8Array>
export function ajaxGet<T = any>(params: AjaxGetParams<'json' | 'xml'>): Task<T>
export function ajaxGet(params: AjaxGetParams<'string' | 'binary'>): Task<string | Uint8Array>
export function ajaxGet(params: AjaxGetParams<'string' | 'binary' | 'json' | 'xml'>): Task<string | Uint8Array | object>
export function ajaxGet(params: AjaxGetParams<'string' | 'binary' | 'json' | 'xml'> | string) {
    if (typeof params === 'string') return ajaxGetInternal(params, params, 'string', false);
    return ajaxGetInternal(params.title, params.url, params.type || 'string', false /* params.compression === DataCompressionMethod.Gzip */, params.body);
}

export type AjaxTask = typeof ajaxGet

function decompress(buffer: Uint8Array): Uint8Array {
    // TODO
    throw 'nyi';
    // const gzip = new LiteMolZlib.Gunzip(new Uint8Array(buffer));
    // return gzip.decompress();
}

async function processFile(ctx: RuntimeContext, asUint8Array: boolean, compressed: boolean, e: any) {
    const data = (e.target as FileReader).result;

    if (compressed) {
        await ctx.update('Decompressing...');

        const decompressed = decompress(new Uint8Array(data as ArrayBuffer));
        if (asUint8Array) {
            return decompressed;
        } else {
            return utf8Read(decompressed, 0, decompressed.length);
        }
    } else {
        return asUint8Array ? new Uint8Array(data as ArrayBuffer) : data as string;
    }
}

function readData(ctx: RuntimeContext, action: string, data: XMLHttpRequest | FileReader, asUint8Array: boolean): Promise<any> {
    return new Promise<any>((resolve, reject) => {
        data.onerror = (e: any) => {
            const error = (<FileReader>e.target).error;
            reject(error ? error : 'Failed.');
        };

        let hasError = false;
        data.onprogress = (e: ProgressEvent) => {
            if (!ctx.shouldUpdate || hasError) return;

            try {
                if (e.lengthComputable) {
                    ctx.update({ message: action, isIndeterminate: false, current: e.loaded, max: e.total });
                } else {
                    ctx.update({ message: `${action} ${(e.loaded / 1024 / 1024).toFixed(2)} MB`, isIndeterminate: true });
                }
            } catch (e) {
                hasError = true;
                reject(e);
            }
        }
        data.onload = (e: any) => resolve(e);
    });
}

function readFromFileInternal(file: File, asUint8Array: boolean): Task<string | Uint8Array> {
    let reader: FileReader | undefined = void 0;
    return Task.create('Read File', async ctx => {
        try {
            reader = new FileReader();
            const isCompressed = /\.gz$/i.test(file.name);

            if (isCompressed || asUint8Array) reader.readAsArrayBuffer(file);
            else reader.readAsBinaryString(file);

            ctx.update({ message: 'Opening file...', canAbort: true });
            const e = await readData(ctx, 'Reading...', reader, asUint8Array);
            const result = processFile(ctx, asUint8Array, isCompressed, e);
            return result;
        } finally {
            reader = void 0;
        }
    }, () => {
        if (reader) reader.abort();
    });
}

class RequestPool {
    private static pool: XMLHttpRequest[] = [];
    private static poolSize = 15;

    static get() {
        if (this.pool.length) {
            return this.pool.pop()!;
        }
        return new XHR();
    }

    static emptyFunc() { }

    static deposit(req: XMLHttpRequest) {
        if (this.pool.length < this.poolSize) {
            req.onabort = RequestPool.emptyFunc;
            req.onerror = RequestPool.emptyFunc;
            req.onload = RequestPool.emptyFunc;
            req.onprogress = RequestPool.emptyFunc;
            this.pool.push(req);
        }
    }
}

async function processAjax(ctx: RuntimeContext, asUint8Array: boolean, decompressGzip: boolean, e: any) {
    const req = (e.target as XMLHttpRequest);
    if (req.status >= 200 && req.status < 400) {
        if (asUint8Array) {
            const buff = new Uint8Array(e.target.response);
            RequestPool.deposit(e.target);

            if (decompressGzip) {
                return decompress(buff);
            } else {
                return buff;
            }
        }
        else {
            const text = e.target.responseText;
            RequestPool.deposit(e.target);
            return text;
        }
    } else {
        const status = req.statusText;
        RequestPool.deposit(e.target);
        throw status;
    }
}

function ajaxGetInternal(title: string | undefined, url: string, type: 'json' | 'xml' | 'string' | 'binary', decompressGzip: boolean, body?: string): Task<string | Uint8Array> {
    let xhttp: XMLHttpRequest | undefined = void 0;
    return Task.create(title ? title : 'Download', async ctx => {
        const asUint8Array = type === 'binary';
        if (!asUint8Array && decompressGzip) {
            throw 'Decompress is only available when downloading binary data.';
        }

        xhttp = RequestPool.get();
       
        xhttp.open('post', url, true);
        xhttp.responseType = asUint8Array ? 'arraybuffer' : 'text';
        // xhttp.setRequestHeader("Accept", "*/*");
        // xhttp.setRequestHeader("Accept-Encoding", "gzip, deflate");
        // xhttp.setRequestHeader("Accept-Language", "en-GB,en-US;q=0.9,en;q=0.8");
        xhttp.setRequestHeader("Content-type", "application/json");
        // xhttp.setRequestHeader("Cache-Control", "no-cache");
        // xhttp.setRequestHeader("Content-length", '65');
        xhttp.send(body);

        await ctx.update({ message: 'Waiting for server...', canAbort: true });
        const e = await readData(ctx, 'Downloading...', xhttp, asUint8Array);
        xhttp = void 0;
        const result = await processAjax(ctx, asUint8Array, decompressGzip, e)

        if (type === 'json') {
            await ctx.update({ message: 'Parsing JSON...', canAbort: false });
            return JSON.parse(result);
        } else if (type === 'xml') {
            await ctx.update({ message: 'Parsing XML...', canAbort: false });
            return parseXml(result);
        }

        return result;
    }, () => {
        if (xhttp) {
            xhttp.abort();
            xhttp = void 0;
        }
    });
}