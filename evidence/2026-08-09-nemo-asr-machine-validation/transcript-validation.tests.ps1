Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'run-spike.ps1') -ValidationTestOnly

function Assert-Equal($Expected, $Actual, [string]$Label) {
    if ($Expected -ne $Actual) { throw "$Label expected '$Expected', got '$Actual'." }
    Write-Host "PASS $Label -> $Actual"
}

function Assert-Match([string]$Pattern, $Values, [string]$Label) {
    $text = @($Values) -join "`n"
    if ($text -notmatch $Pattern) { throw "$Label expected /$Pattern/ in '$text'." }
    Write-Host "PASS $Label"
}

function ConvertTo-ControlledJson($Value) {
    return $Value | ConvertTo-Json -Depth 10 -Compress | ConvertFrom-Json
}

function New-ValidDocument([string]$Text = 'hello', $Words = $null) {
    if ($null -eq $Words) { $Words = @([ordered]@{ word='hello'; start=0.0; end=0.5; confidence=0.95 }) }
    return ConvertTo-ControlledJson ([ordered]@{
        file='controlled.wav'
        text=$Text
        confidence=0.95
        duration=10.0
        languages=@('en')
        words=$Words
    })
}

function Measure-WithoutThrow($Document, [string[]]$Keyterms = @()) {
    try {
        return Measure-Transcript $Document 'hello' 10.0 $Keyterms @()
    } catch {
        throw "Measure-Transcript threw instead of returning schema errors: $($_.Exception.Message)"
    }
}

$recipe = Get-Content -LiteralPath (Join-Path $root 'fixture-recipe.json') -Raw | ConvertFrom-Json
$cleanRecipe = @($recipe.fixtures | Where-Object { $_.id -eq 'clean-keyterms' })[0]
$keyterms = @($cleanRecipe.keyterms | ForEach-Object { [string]$_ })
Assert-Equal 12 $keyterms.Count 'manifest exact-keyterm count'

$scalarDocumentResult = Measure-WithoutThrow (ConvertTo-ControlledJson 42)
Assert-Equal $false $scalarDocumentResult.schemaValid 'non-object transcript is rejected without throwing'
Assert-Match 'document: expected a JSON object' $scalarDocumentResult.schemaErrors 'non-object transcript has an explicit schema error'

$missingTop = New-ValidDocument
$missingTop.psobject.Properties.Remove('file')
$missingTopResult = Measure-WithoutThrow $missingTop
Assert-Equal $false $missingTopResult.schemaValid 'missing top-level field is rejected without throwing'
Assert-Match '^file: required field is missing$' $missingTopResult.schemaErrors 'missing top-level field has an explicit schema error'

foreach ($case in @(
    @{ field='file'; value=42; error='file: expected a non-empty string' },
    @{ field='text'; value=$false; error='text: expected a string' },
    @{ field='confidence'; value='high'; error='confidence: expected a finite number' },
    @{ field='duration'; value='ten'; error='duration: expected a finite number' },
    @{ field='languages'; value='en'; error='languages: expected an array' },
    @{ field='words'; value='hello'; error='words: expected an array' }
)) {
    $document = New-ValidDocument
    $document.($case.field) = $case.value
    $result = Measure-WithoutThrow $document
    Assert-Equal $false $result.schemaValid "wrong-type top-level $($case.field) is rejected"
    Assert-Match ([regex]::Escape($case.error)) $result.schemaErrors "wrong-type top-level $($case.field) is explicit"
}

$scalarWord = New-ValidDocument 'hello' @('hello')
$scalarWordResult = Measure-WithoutThrow $scalarWord
Assert-Equal $false $scalarWordResult.schemaValid 'non-object word is rejected without throwing'
Assert-Match 'words\[0\]: expected an object' $scalarWordResult.schemaErrors 'non-object word has an explicit schema error'

$missingWord = New-ValidDocument
$missingWord.words[0].psobject.Properties.Remove('confidence')
$missingWordResult = Measure-WithoutThrow $missingWord
Assert-Equal $false $missingWordResult.schemaValid 'missing word field is rejected without throwing'
Assert-Match 'words\[0\]\.confidence: required field is missing' $missingWordResult.schemaErrors 'missing word field has an explicit schema error'

foreach ($case in @(
    @{ field='word'; value=42; error='words\[0\]\.word: expected a meaningful string' },
    @{ field='start'; value='zero'; error='words\[0\]\.start: expected a finite number' },
    @{ field='end'; value=$false; error='words\[0\]\.end: expected a finite number' },
    @{ field='confidence'; value='high'; error='words\[0\]\.confidence: expected a finite number' }
)) {
    $document = New-ValidDocument
    $document.words[0].($case.field) = $case.value
    $result = Measure-WithoutThrow $document
    Assert-Equal $false $result.schemaValid "wrong-type word $($case.field) is rejected"
    Assert-Match $case.error $result.schemaErrors "wrong-type word $($case.field) is explicit"
}

$emptyWords = New-ValidDocument 'hello' @()
$emptyWordsResult = Measure-WithoutThrow $emptyWords
Assert-Equal $false $emptyWordsResult.schemaValid 'empty words array is rejected for nonempty audio'
Assert-Match 'words: expected at least one meaningful word' $emptyWordsResult.schemaErrors 'empty words array has an explicit schema error'

$emptyWord = New-ValidDocument 'hello' @([ordered]@{ word='!!!'; start=0.0; end=0.5; confidence=0.9 })
$emptyWordResult = Measure-WithoutThrow $emptyWord
Assert-Equal $false $emptyWordResult.schemaValid 'punctuation-only word is not meaningful'

$malformedIntervals = New-ValidDocument 'one two three four' @(
    [ordered]@{ word='one'; start=-0.1; end=0.2; confidence=0.9 },
    [ordered]@{ word='two'; start=0.5; end=0.5; confidence=0.9 },
    [ordered]@{ word='three'; start=0.4; end=0.8; confidence=0.9 },
    [ordered]@{ word='four'; start=9.5; end=10.5; confidence=0.9 }
)
$intervalResult = Measure-WithoutThrow $malformedIntervals
Assert-Equal $false $intervalResult.schemaValid 'malformed intervals are rejected without throwing'
Assert-Equal 4 $intervalResult.invalidIntervals 'all malformed intervals are counted'
Assert-Match 'start must be non-negative' $intervalResult.schemaErrors 'negative interval error is explicit'
Assert-Match 'end must be greater than start' $intervalResult.schemaErrors 'zero-length interval error is explicit'
Assert-Match 'start precedes the previous word' $intervalResult.schemaErrors 'non-monotonic interval error is explicit'
Assert-Match 'end exceeds source duration' $intervalResult.schemaErrors 'out-of-source interval error is explicit'

$substringText = @($keyterms | ForEach-Object { "${_}x" }) -join ' '
$substringResult = Measure-WithoutThrow (New-ValidDocument $substringText) $keyterms
Assert-Equal 0 $substringResult.keytermMatches 'substring-only keyterms do not count as exact matches'
Assert-Equal 0 $substringResult.keytermRecall 'substring-only keyterm recall is zero'

$exactText = $keyterms -join ' | '
$exactResult = Measure-WithoutThrow (New-ValidDocument $exactText) $keyterms
Assert-Equal $true $exactResult.schemaValid 'controlled all-keyterm transcript is schema-valid'
Assert-Equal 12 $exactResult.keytermCount 'all manifest keyterms are measured'
Assert-Equal 12 $exactResult.keytermMatches 'date, currency, decimal, phone, and named keyterms match exactly'
Assert-Equal 1 $exactResult.keytermRecall 'all-keyterm exact recall is one'
foreach ($specialTerm in @('August 9 2026','$1,234.56','3.14159','415 555 0137')) {
    $specialResult = @($exactResult.keytermResults | Where-Object { $_.term -eq $specialTerm })
    Assert-Equal 1 $specialResult.Count "special keyterm '$specialTerm' is declared and measured"
    Assert-Equal $true $specialResult[0].matched "special keyterm '$specialTerm' uses exact token/phrase matching"
}

Write-Host 'All structured transcript validation tests passed.'
