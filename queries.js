/** SPARQL query builders. Dynamic values are escaped before interpolation. */
import {identifierUrls, websiteVariants} from './model.js';

/** Encode a plain string as a SPARQL string literal. */
export function sparqlLiteral(value) {
	return JSON.stringify(String(value));
}

/** Accept only Wikidata item or property IDs before constructing an IRI. */
export function entityIri(id) {
	if (!/^[QP][1-9]\d*$/.test(id)) {
		throw new TypeError('Invalid Wikidata entity ID');
	}
	return 'http://www.wikidata.org/entity/' + id;
}

/** Fetch non-deprecated formatters; ID validation is separate from the URL template. */
export function formattersQuery() {
	return `SELECT DISTINCT ?prop ?regex ?formatter_url WHERE {
		VALUES (?claim ?value) { (p:P1630 ps:P1630) (p:P3303 ps:P3303) }
		?prop ?claim ?statement.
		?statement ?value ?formatter_url; wikibase:rank ?rank.
		FILTER(?rank != wikibase:DeprecatedRank && CONTAINS(?formatter_url, "$1"))
		OPTIONAL {
			{ ?prop wdt:P1793 ?regex. }
			UNION { ?prop p:P2302 [ ps:P2302 wd:Q21502404; pq:P1793 ?regex ]. }
		}
	}`;
}

/** Include domain qualifiers so thousands of URL patterns can be indexed by host. */
export function matchPatternsQuery() {
	return `SELECT ?prop ?matchpattern ?replacementvalue ?domain WHERE {
		?prop p:P8966 ?statement.
		?statement ps:P8966 ?matchpattern; wikibase:rank ?rank.
		FILTER(?rank != wikibase:DeprecatedRank)
		OPTIONAL { ?statement pq:P8967 ?replacementvalue. }
		OPTIONAL { ?statement pq:P13337 ?domain. }
	}`;
}

/** Build the languages query. */
export function languagesQuery() {
	return 'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>'
		+ 'PREFIX wd: <http://www.wikidata.org/entity/>'
		+ 'PREFIX wdt: <http://www.wikidata.org/prop/direct/>'
		+ 'SELECT DISTINCT ?lang ?data ?entity ?language ?tongue ?pedia ?commons ?books ?functions ?news ?quote ?source ?versity ?voyage ?tionary ?species WHERE { hint:Query hint:optimizer "None".  ?tongueitem wdt:P424 ?lang .  ?tongueitem wdt:P31/wdt:P279* wd:Q17376908 .  wd:Q52 rdfs:label ?pedia .  \u0009'
		+ 'FILTER(LANG(?pedia)=?lang)  '
		+ 'OPTIONAL{wd:Q2013 rdfs:label ?data .    '
		+ 'FILTER(LANG(?data)=?lang)}  '
		+ 'OPTIONAL{wd:Q35120 rdfs:label ?entity .    '
		+ 'FILTER(LANG(?entity)=?lang)}  '
		+ 'OPTIONAL{wd:Q34770 rdfs:label ?language .    '
		+ 'FILTER(LANG(?language)=?lang)}  '
		+ 'OPTIONAL{wd:Q565 rdfs:label ?commons .    '
		+ 'FILTER(LANG(?commons)=?lang)}  '
		+ 'OPTIONAL{wd:Q367 rdfs:label ?books .    '
		+ 'FILTER(LANG(?books)=?lang)}  '
		+ 'OPTIONAL{wd:Q104587954 rdfs:label ?functions .    '
		+ 'FILTER(LANG(?functions)=?lang)}  '
		+ 'OPTIONAL{wd:Q964 rdfs:label ?news .    '
		+ 'FILTER(LANG(?news)=?lang)}  '
		+ 'OPTIONAL{wd:Q369 rdfs:label ?quote .    '
		+ 'FILTER(LANG(?quote)=?lang)}  '
		+ 'OPTIONAL{wd:Q263 rdfs:label ?source .    '
		+ 'FILTER(LANG(?source)=?lang)}  '
		+ 'OPTIONAL{wd:Q370 rdfs:label ?versity .    '
		+ 'FILTER(LANG(?versity)=?lang)}  '
		+ 'OPTIONAL{wd:Q373 rdfs:label ?voyage .    '
		+ 'FILTER(LANG(?voyage)=?lang)}  '
		+ 'OPTIONAL{wd:Q151 rdfs:label ?tionary .    '
		+ 'FILTER(LANG(?tionary)=?lang)}  '
		+ 'OPTIONAL{wd:Q13679 rdfs:label ?species .    '
		+ 'FILTER(LANG(?species)=?lang)}  ?tongueitem rdfs:label ?tongue .  '
		+ 'FILTER(LANG(?tongue)=?lang)}'
		+ 'ORDER BY ASC(?lang)'
		+ 'LIMIT 500';
}

/** Look up identifiers on all non-deprecated statements, including normal-ranked values. */
function identifierLookup(source, language) {
	return `SELECT DISTINCT ?iri ?iriLabel WHERE {
		hint:Query hint:optimizer "None".
		${source}
		?prop wikibase:claim ?claim; wikibase:statementProperty ?valueProperty.
		?statement ?valueProperty ?id; wikibase:rank ?rank.
		FILTER(?rank != wikibase:DeprecatedRank)
		?iri ?claim ?statement.
		SERVICE wikibase:label { bd:serviceParam wikibase:language ${sparqlLiteral(language)}. }
	} ORDER BY ?iriLabel`;
}

/** Use locally extracted IDs when cached metadata is available, avoiding a server-side regex scan. */
export function identifiersQuery(identifiers, language) {
	const values = identifiers.map(({prop, id}) => {
		if (!/^P[1-9]\d*$/.test(prop)) throw new TypeError('Invalid Wikidata property ID');
		return '(wd:' + prop + ' ' + sparqlLiteral(id) + ')';
	}).join(' ');
	return identifierLookup('VALUES (?prop ?id) { ' + values + ' }', language);
}

/** Resolve uncached URLs using P8966/P8967 patterns and reversible formatter templates. */
export function searchQuery(url, language) {
	const urls = identifierUrls(url).map(sparqlLiteral).join(' ');
	const source = `{
			VALUES ?test_url0 { ${urls} }
			?prop p:P8966 ?rule.
			?rule ps:P8966 ?matchpattern; wikibase:rank ?ruleRank.
			FILTER(?ruleRank != wikibase:DeprecatedRank && REGEX(?test_url0, ?matchpattern))
			OPTIONAL { ?rule pq:P8967 ?replacementvalue. }
			BIND(REPLACE(COALESCE(?replacementvalue, ${sparqlLiteral('\\1')}), ${sparqlLiteral('\\\\([0-9]+)')}, ${sparqlLiteral('\\$$1')}) AS ?replacement)
			BIND(REPLACE(?test_url0, CONCAT("^.*?(?:", ?matchpattern, ").*$"), ?replacement) AS ?id)
		} UNION {
			VALUES ?test_url0 { ${urls} }
			VALUES (?formatterClaim ?formatterValue) { (p:P1630 ps:P1630) (p:P3303 ps:P3303) }
			?prop ?formatterClaim ?formatterStatement.
			?formatterStatement ?formatterValue ?formatter_url0; wikibase:rank ?formatterRank.
			FILTER(?formatterRank != wikibase:DeprecatedRank && CONTAINS(?formatter_url0, "$1"))
			BIND(REPLACE(?test_url0, "^https?://(?:www[.])?", "") AS ?test_url1)
			BIND(REPLACE(?test_url1, "/$", "") AS ?test_url)
			BIND(REPLACE(?formatter_url0, "^https?://(?:www[.])?", "") AS ?formatter_url1)
			BIND(REPLACE(?formatter_url1, "/$", "") AS ?formatter_url)
			BIND(STRBEFORE(?formatter_url, "$1") AS ?start)
			BIND(STRAFTER(?formatter_url, "$1") AS ?end)
			FILTER(STRSTARTS(?test_url, ?start) && STRENDS(?test_url, ?end))
			BIND(SUBSTR(?test_url, 1 + STRLEN(?start), STRLEN(?test_url) - STRLEN(?start) - STRLEN(?end)) AS ?id)
			OPTIONAL {
				{ ?prop wdt:P1793 ?regex. }
				UNION { ?prop p:P2302 [ ps:P2302 wd:Q21502404; pq:P1793 ?regex ]. }
			}
			FILTER(STRLEN(?id) > 0 && (!BOUND(?regex) || REGEX(?id, CONCAT("^(?:", ?regex, ")$"))))
		}`;
	return identifierLookup(source, language);
}

/** Match URL aliases, ranking direct official websites and preferred statements first. */
export function websiteQuery(url, language) {
	return `SELECT DISTINCT ?iri ?iriLabel WHERE {
		hint:Query hint:optimizer "None".
		VALUES ?url { ${websiteVariants(url).map(sparqlLiteral).join(' ')} }
		BIND(IRI(?url) AS ?uri)
		{
			?statement ?valueProperty ?uri.
			?urlProperty wikibase:statementProperty ?valueProperty; wikibase:propertyType wikibase:Url.
		} UNION {
			?statement ?qualifier ?uri.
			?urlProperty wikibase:qualifier ?qualifier; wikibase:propertyType wikibase:Url.
		}
		?statement wikibase:rank ?rank.
		FILTER(?rank != wikibase:DeprecatedRank)
		?iri ?claim ?statement.
		?property wikibase:claim ?claim.
		BIND(BOUND(?valueProperty) && ?urlProperty = wd:P856 AS ?officialWebsite)
		SERVICE wikibase:label { bd:serviceParam wikibase:language ${sparqlLiteral(language)}. }
	} ORDER BY DESC(?officialWebsite) DESC(?rank = wikibase:PreferredRank) ?iriLabel LIMIT 100`;
}

/** Build the title query. */
export function titleQuery(id, language) {
	return 'PREFIX schema: <http://schema.org/>'
		+ 'SELECT DISTINCT ?itemLabel ?itemDesc ?image WHERE {'
		+ 'OPTIONAL {<'
		+ entityIri(id)
		+ '> rdfs:label ?itemLabel.'
		+ 'FILTER(LANG(?itemLabel) = '
		+ sparqlLiteral(language)
		+ ')}'
		+ 'OPTIONAL {<'
		+ entityIri(id)
		+ '> schema:description ?itemDesc.FILTER ( lang(?itemDesc) = '
		+ sparqlLiteral(language)
		+ ' )}'
		+ 'OPTIONAL {?subProperties wdt:P1647* wd:P18.?subProperties wikibase:directClaim ?propertyRel.<'
		+ entityIri(id)
		+ '> ?propertyRel ?image.}}'
		+ 'ORDER BY ASC(xsd:integer(STRAFTER(STR(?subProperties), "P")))'
		+ 'LIMIT 1';
}

/** Build the articles query. */
export function articlesQuery(id) {
	return 'PREFIX schema: <http://schema.org/>'
		+ 'SELECT DISTINCT ?article ?articlelang WHERE {?article schema:about <'
		+ entityIri(id)
		+ '> .?article schema:inLanguage ?articlelang .}';
}

/** Link entity-valued properties to Wikidata and expose available listening links for tracks. */
export function propertiesQuery(id, language) {
	const item = '<' + entityIri(id) + '>';
	return `SELECT DISTINCT ?property ?value ?valueUri ?externalUrl ?websiteUrl WHERE {
		${item} ?propertyUri ?valueUri.
		?genProp wikibase:directClaim ?propertyUri; rdfs:label ?property.
		?valueUri rdfs:label ?value.
		FILTER(LANG(?property) = ${sparqlLiteral(language)} && LANG(?value) = ${sparqlLiteral(language)})
		OPTIONAL {
			${item} wdt:P658 ?valueUri.
			?valueUri ?externalPredicate ?identifier.
			?externalProperty wikibase:directClaim ?externalPredicate; wdt:P1630 ?formatter.
			FILTER(CONTAINS(?formatter, "$1"))
			BIND(IRI(CONCAT(STRBEFORE(?formatter, "$1"), STR(?identifier), STRAFTER(?formatter, "$1"))) AS ?externalUrl)
		}
		OPTIONAL {
			${item} wdt:P658 ?valueUri.
			?valueUri wdt:P2699|wdt:P856|wdt:P973 ?websiteUrl.
		}
	} ORDER BY ?property`;
}

/** Build the values query. */
export function valuesQuery(id, language) {
	return 'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>'
		+ 'PREFIX wd: <http://www.wikidata.org/entity/>'
		+ 'PREFIX wdt: <http://www.wikidata.org/prop/direct/>'
		+ 'SELECT DISTINCT ?property ?valueUri ?URL WHERE {<'
		+ entityIri(id)
		+ '>  ?propertyUri ?valueUri.?genProp <http://wikiba.se/ontology#directClaim> ?propertyUri.?genProp rdfs:label ?property.'
		+ 'FILTER(substr(str(?propertyUri),1,36)="http://www.wikidata.org/prop/direct/")'
		+ 'FILTER(LANG(?property) = '
		+ sparqlLiteral(language)
		+ ')'
		+ 'FILTER(substr(str(?valueUri),1,31)!="http://www.wikidata.org/entity/")'
		+ 'OPTIONAL { ?genProp wdt:P1630 ?fmt_URL . }'
		+ 'FILTER(!BOUND(?fmt_URL))}'
		+ 'ORDER BY ASC(?property)';
}

/** Build the links query. */
export function linksQuery(id, language) {
	return 'SELECT DISTINCT ?genProp ?property ?valueUri ?fmt_URL ?rankstr ?regex_req ?regex ?lang ?format ?part ?operatorLabel ?jurisdiction WHERE {<'
		+ entityIri(id)
		+ '>  ?propertyUri ?valueUri.?genProp <http://wikiba.se/ontology#directClaim> ?propertyUri.?genProp rdfs:label ?property.'
		+ 'FILTER(LANG(?property) = '
		+ sparqlLiteral(language)
		+ ')'
		+ 'FILTER(substr(str(?propertyUri),1,36)="http://www.wikidata.org/prop/direct/")'
		+ 'FILTER(substr(str(?valueUri),1,31)!="http://www.wikidata.org/entity/"){?genProp p:P1630 ?statement .?statement ps:P1630 ?fmt_URL .?statement wikibase:rank ?rank .'
		+ 'BIND (STR(?rank) AS ?rankstr)'
		+ 'OPTIONAL {?statement pq:P8460 ?regex_req .}'
		+ 'OPTIONAL {?statement pq:P1793 ?regex .}'
		+ 'OPTIONAL {?statement pq:P407/wdt:P424 ?lang .}'
		+ 'OPTIONAL {?statement pq:P2701 ?format .}'
		+ 'OPTIONAL {?statement pq:P518 ?part .}'
		+ 'OPTIONAL {?statement pq:P137 ?operator .}'
		+ 'OPTIONAL {?statement pq:P1001 ?jurisdiction .}} '
		+ 'UNION {?genProp p:P3303 ?statement .?statement ps:P3303 ?fmt_URL .?statement wikibase:rank ?rank.'
		+ 'BIND (STR(?rank) AS ?rankstr)'
		+ 'OPTIONAL {?statement pq:P8460 ?regex_req .}'
		+ 'OPTIONAL {?statement pq:P1793 ?regex .}'
		+ 'OPTIONAL {?statement pq:P407/wdt:P424 ?lang .}'
		+ 'OPTIONAL {?statement pq:P2701 ?format .}'
		+ 'OPTIONAL {?statement pq:P518 ?part .}'
		+ 'OPTIONAL {?statement pq:P137 ?operator .}'
		+ 'OPTIONAL {?statement pq:P1001 ?jurisdiction .}}'
		+ 'BIND (CONCAT(?property,?valueUri) AS ?sort)'
		+ 'SERVICE wikibase:label { bd:serviceParam wikibase:language '
		+ sparqlLiteral(language + ',[AUTO_LANGUAGE],en')
		+ ' } .}'
		+ 'ORDER BY ASC(?sort)';
}
